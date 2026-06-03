import { UIMessage, appendResponseMessages, createDataStreamResponse, smoothStream, streamText } from 'ai';
import { notFound } from 'next/navigation';
import { NextRequest } from 'next/server';
import { generateTitleFromUserMessage } from '~/app/(main)/projects/[project]/chats/actions';
import { generateUUID } from '~/components/chat/utils';
import { getChatSystemPrompt } from '~/lib/ai/agent';
import { getLanguageModel } from '~/lib/ai/providers';
import { getTools } from '~/lib/ai/tools';
import { deleteChatById, getChatById, getChatsByProject, saveChat } from '~/lib/db/chats';
import { getConnection } from '~/lib/db/connections';
import { getUserSessionDBAccess } from '~/lib/db/db';
import { getProjectById } from '~/lib/db/projects';
import { getTargetDbPool } from '~/lib/targetdb/db';
import { requireUserSession } from '~/utils/route';

export const maxDuration = 60;

// Turn upstream LLM-provider errors into a clear, actionable message in the chat UI.
// Default behavior in the AI SDK just surfaces "An error occurred" — useless when
// the real cause is a rate limit, auth failure, model not found, etc.
function formatChatErrorForUi(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.message ?? String(error))
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);

  // Anthropic / OpenAI rate limits
  if (/rate.?limit|429/i.test(raw)) {
    // Pull the retry-after seconds from common patterns
    const retryMatch = raw.match(/['"]?retry-after['"]?\s*[:=]\s*['"]?(\d+)/i);
    const retry = retryMatch ? `${retryMatch[1]}s` : 'about a minute';
    // Pull the input-tokens-per-minute limit if present (Anthropic header)
    const limMatch = raw.match(/['"]?anthropic-ratelimit-input-tokens-limit['"]?\s*[:=]\s*['"]?(\d+)/i);
    const limit = limMatch ? ` Your tier allows ${limMatch[1]} input tokens/min.` : '';
    return [
      `⚠️ **LLM provider rate limit hit (HTTP 429).** Retry in ~${retry}.${limit}`,
      '',
      'Things you can do right now:',
      "- Switch to a Sonnet 4.5 model in the chat's model dropdown (5× more headroom on the same tier than Haiku/Opus).",
      '- Be specific to cut tool-call loops — ask for one section/playbook instead of "run everything".',
      '- Disable unused MCP servers on the MCP page (each one adds ~2k tokens per request).',
      '',
      `_raw: ${raw.slice(0, 300)}_`
    ].join('\n');
  }

  // 401 / auth
  if (/401|unauthorized|invalid.*api.*key|authentication/i.test(raw)) {
    return `❌ **LLM provider rejected the API key (HTTP 401).** Check OPENAI_API_KEY / ANTHROPIC_API_KEY in apps/dbagent/.env.local and restart the server.\n\n_raw: ${raw.slice(0, 300)}_`;
  }

  // Model not found
  if (/model.*not.*found|invalid.*model|404.*model/i.test(raw)) {
    return `❌ **Model not found.** The model id selected in the dropdown may be retired or unavailable on your account. Pick a different one (e.g. claude-sonnet-4-5).\n\n_raw: ${raw.slice(0, 300)}_`;
  }

  // Context window
  if (/context.*length|maximum.*token|prompt.*too.*long|context_length_exceeded/i.test(raw)) {
    return `❌ **Context window exceeded.** This chat has grown too long for the model. Start a fresh chat, or pick a model with a larger context window.\n\n_raw: ${raw.slice(0, 300)}_`;
  }

  // Postgres errors surfaced from a tool (read-only tx, permission, etc.)
  if (/read.?only.*transaction/i.test(raw)) {
    return `❌ **The agent tried to write to a target DB and was blocked (read-only transaction).** This is the safety guard working. Check the conversation: the LLM hallucinated a non-SELECT statement.\n\n_raw: ${raw.slice(0, 300)}_`;
  }
  if (/permission denied/i.test(raw)) {
    return `❌ **Permission denied on the target DB.** The connection's Postgres role lacks a needed grant. See OPERATIONS.md §2 for the recommended xata_agent_ro role setup.\n\n_raw: ${raw.slice(0, 300)}_`;
  }

  // Network / target DB unreachable
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|getaddrinfo/i.test(raw)) {
    return `❌ **Cannot reach the target Postgres.** Connection refused / timed out. Check the connection string and that the target is running.\n\n_raw: ${raw.slice(0, 300)}_`;
  }

  // Generic fallback — still better than the default
  return `❌ **Error processing the chat:** ${raw.slice(0, 500)}`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const project = searchParams.get('project');
  if (!project) {
    return new Response('Project is required', { status: 400 });
  }

  const limit = parseInt(searchParams.get('limit') || '10', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const dbAccess = await getUserSessionDBAccess();

  const chats = await getChatsByProject(dbAccess, { project, limit, offset });

  return Response.json({ chats });
}

export async function POST(request: Request) {
  try {
    const { id, messages, connectionId, model: modelId, useArtifacts } = await request.json();

    const userId = await requireUserSession();
    const dbAccess = await getUserSessionDBAccess();
    const connection = await getConnection(dbAccess, connectionId);
    if (!connection) {
      console.error('Connection not found', connectionId);
      return new Response('Connection not found', { status: 400 });
    }

    const project = await getProjectById(dbAccess, connection.projectId);
    if (!project) {
      return new Response('Project not found', { status: 400 });
    }

    const userMessage = getMostRecentUserMessage(messages);
    if (!userMessage) {
      return new Response('No user message found', { status: 400 });
    }

    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    const targetDb = getTargetDbPool(connection.connectionString);
    const context = getChatSystemPrompt({
      cloudProvider: project.cloudProvider,
      useArtifacts
    });
    const model = await getLanguageModel(modelId);

    return createDataStreamResponse({
      execute: async (dataStream) => {
        const tools = await getTools({ project, connection, targetDb, useArtifacts, userId, dataStream });

        const result = streamText({
          model: model.instance(),
          system: context,
          messages,
          // Lower default: most useful chats finish in 3-5 steps. Each step
          // re-bills the full context to the LLM, so 20 was wildly expensive.
          maxSteps: 8,
          toolCallStreaming: true,
          experimental_transform: smoothStream({ chunking: 'word' }),
          experimental_generateMessageId: generateUUID,
          experimental_telemetry: {
            isEnabled: true,
            metadata: {
              projectId: connection.projectId,
              connectionId: connectionId,
              sessionId: id,
              model: model.info().id,
              userId,
              cloudProvider: project.cloudProvider,
              tags: ['chat']
            }
          },
          // Anthropic prompt-cache: tag the system prompt as cacheable so the
          // ~3 KB system block isn't re-billed on each of the up-to-20 agentic
          // steps. Other providers ignore this field.
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } }
          },
          tools,
          onFinish: async ({ response }) => {
            try {
              const assistantId = getTrailingMessageId({
                messages: response.messages.filter((message) => message.role === 'assistant')
              });

              if (!assistantId) {
                throw new Error('No assistant message found!');
              }

              const [, assistantMessage] = appendResponseMessages({
                messages: [userMessage],
                responseMessages: response.messages
              });

              if (!assistantMessage) {
                throw new Error('No assistant message found!');
              }

              const title =
                !chat.title || chat.title === 'New chat'
                  ? await generateTitleFromUserMessage({ message: userMessage })
                  : chat.title;

              await saveChat(
                dbAccess,
                {
                  ...chat,
                  title,
                  model: model.info().id,
                  connectionId
                },
                [
                  {
                    chatId: id,
                    id: userMessage.id,
                    projectId: connection.projectId,
                    role: 'user',
                    parts: userMessage.parts,
                    createdAt: new Date()
                  },
                  {
                    id: assistantId,
                    projectId: connection.projectId,
                    chatId: id,
                    role: assistantMessage.role,
                    parts: assistantMessage.parts,
                    createdAt: new Date()
                  }
                ]
              );
            } catch (error) {
              console.error('Failed to save chat', error);
            } finally {
              await targetDb.end();
            }
          }
        });

        void result.consumeStream();

        result.mergeIntoDataStream(dataStream, { sendReasoning: true });
      },
      onError: (error) => {
        console.error('Error in data stream:', error);
        return formatChatErrorForUi(error);
      }
    });
  } catch (error) {
    console.error('Error in chat API:', error);
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const dbAccess = await getUserSessionDBAccess();

  try {
    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    await deleteChatById(dbAccess, { id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

export async function PATCH(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const { title } = await request.json();
  if (!title) {
    return new Response('Title is required', { status: 400 });
  }

  const dbAccess = await getUserSessionDBAccess();

  try {
    const chat = await getChatById(dbAccess, { id });
    if (!chat) notFound();

    await saveChat(dbAccess, { ...chat, title });

    return new Response('Chat updated', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request!', {
      status: 500
    });
  }
}

function getMostRecentUserMessage(messages: Array<UIMessage>) {
  const userMessages = messages.filter((message) => message.role === 'user');
  return userMessages.at(-1);
}

function getTrailingMessageId({ messages }: { messages: Array<{ id: string }> }): string | null {
  const trailingMessage = messages.at(-1);

  if (!trailingMessage) return null;

  return trailingMessage.id;
}
