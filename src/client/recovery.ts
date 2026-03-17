/**
 * Job recovery: on page load, check for pending/completed/failed jobs
 * and apply them to the chat via __pluginApis__.
 */

import { showNotification } from './notification';

declare const __pluginApis__: {
  getDatabase(): {
    characters: Array<{
      chaId: string;
      chatPage?: number;
      reloadKeys?: number;
      chats?: Array<{
        message?: Array<{ role: string; data: string; time?: number; saying?: string }>;
        isStreaming?: boolean;
      }>;
    }>;
  };
} | undefined;

interface Job {
  id: string;
  charId: string | null;
  status: string;
  response: string;
  error: string | null;
}

/**
 * Find the character index and chat for a given charId.
 */
function resolveTarget(charId: string): {
  charIndex: number;
  chatIndex: number;
} | null {
  if (typeof __pluginApis__ === 'undefined') return null;
  const db = __pluginApis__?.getDatabase();
  if (!db?.characters) return null;

  const charIndex = db.characters.findIndex((c) => c && c.chaId === charId);
  if (charIndex === -1) return null;

  const char = db.characters[charIndex];
  const chatIndex = char.chatPage ?? 0;
  return { charIndex, chatIndex };
}

/**
 * Apply a completed job's response to the character's chat.
 */
function applyCompletedJob(job: Job): boolean {
  if (!job.charId || !job.response) return false;

  const target = resolveTarget(job.charId);
  if (!target) return false;

  if (typeof __pluginApis__ === 'undefined') return false;
  const db = __pluginApis__?.getDatabase();
  if (!db) return false;

  const char = db.characters[target.charIndex];
  const chat = char?.chats?.[target.chatIndex];
  if (!chat?.message) return false;

  // Check if the last message is from the AI and empty (placeholder)
  const lastMsg = chat.message[chat.message.length - 1];
  if (lastMsg && lastMsg.role === 'char' && !lastMsg.data) {
    // Update existing placeholder
    lastMsg.data = job.response;
    lastMsg.time = Date.now();
  } else {
    // Add new AI message
    chat.message.push({
      role: 'char',
      data: job.response,
      time: Date.now(),
      saying: job.charId,
    });
  }

  // Trigger UI reactivity
  char.reloadKeys = (char.reloadKeys || 0) + 1;
  return true;
}

/**
 * Handle a job that's still streaming — reconnect via SSE.
 */
function reconnectToStream(job: Job): void {
  if (!job.charId) return;

  const target = resolveTarget(job.charId);
  if (!target) return;

  if (typeof __pluginApis__ === 'undefined') return;
  const db = __pluginApis__?.getDatabase();
  if (!db) return;

  const char = db.characters[target.charIndex];
  const chat = char?.chats?.[target.chatIndex];
  if (!chat?.message) return;

  // Ensure there's a message to fill
  let msgIndex = -1;
  const lastMsg = chat.message[chat.message.length - 1];
  if (lastMsg && lastMsg.role === 'char') {
    msgIndex = chat.message.length - 1;
  } else {
    chat.message.push({
      role: 'char',
      data: '',
      time: Date.now(),
      saying: job.charId,
    });
    msgIndex = chat.message.length - 1;
  }

  chat.isStreaming = true;

  const es = new EventSource(`/db/jobs/${job.id}/stream`);

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.text !== undefined && chat.message) {
        chat.message[msgIndex].data = data.text;
        char.reloadKeys = (char.reloadKeys || 0) + 1;
      }

      if (data.type === 'done') {
        chat.isStreaming = false;
        char.reloadKeys = (char.reloadKeys || 0) + 1;
        es.close();

        // Consume the job
        fetch(`/db/jobs/${job.id}/consume`, { method: 'POST' }).catch(() => {});

        if (data.status === 'aborted') {
          showNotification('스트리밍이 중단되었습니다.');
        }
      }

      if (data.type === 'error') {
        chat.isStreaming = false;
        char.reloadKeys = (char.reloadKeys || 0) + 1;
        es.close();
        showNotification(`스트리밍 에러: ${data.error}`, 'error');
        fetch(`/db/jobs/${job.id}/consume`, { method: 'POST' }).catch(() => {});
      }
    } catch {
      // Ignore parse errors
    }
  };

  es.onerror = () => {
    chat.isStreaming = false;
    char.reloadKeys = (char.reloadKeys || 0) + 1;
    es.close();
  };
}

/**
 * Main recovery: check for active jobs and handle them.
 */
export async function recoverJobs(): Promise<void> {
  try {
    const resp = await fetch('/db/jobs/active');
    if (!resp.ok) return;

    const body: { jobs?: Job[] } = await resp.json();
    const { jobs } = body;
    if (!jobs || jobs.length === 0) return;

    for (const job of jobs) {
      switch (job.status) {
        case 'completed': {
          const applied = applyCompletedJob(job);
          if (applied) {
            showNotification('이전 요청의 응답이 복구되었습니다.');
          }
          // Consume regardless of whether it was applied
          fetch(`/db/jobs/${job.id}/consume`, { method: 'POST' }).catch(() => {});
          break;
        }

        case 'streaming': {
          showNotification('진행 중인 스트리밍에 재연결합니다...');
          reconnectToStream(job);
          break;
        }

        case 'failed': {
          showNotification(
            `이전 요청이 실패했습니다: ${job.error || '알 수 없는 오류'}`,
            'error',
          );
          fetch(`/db/jobs/${job.id}/consume`, { method: 'POST' }).catch(() => {});
          break;
        }
      }
    }
  } catch {
    // Recovery is best-effort
  }
}
