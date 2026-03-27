/**
 * Streaming JSON parser for RisuAI character files.
 *
 * stream-json의 parser를 사용하여 캐릭터 JSON을 스트리밍 파싱한다.
 * chats 배열의 각 원소를 개별적으로 emit하여, 전체 파일을 메모리에 올리지 않는다.
 *
 * 피크 메모리: (non-chats 필드 합계) + (가장 큰 단일 chat) ≈ 수 MB
 * cf. 버퍼 방식: 전체 파일 × 3 (Buffer + String + parsed Object) ≈ 수백 MB
 */

import { Readable, Writable, Transform } from 'stream';
import { parser } from 'stream-json';
import { chain } from 'stream-chain';
import crypto from 'crypto';

interface Token {
  name: string;
  value?: unknown;
}

export interface StreamResult {
  fields: Record<string, unknown>;
  hash: string;
}

/**
 * stream-json 토큰 스트림에서 JS 값을 조립하는 미니 어셈블러.
 *
 * 스택 기반으로 동작하며, 최상위 값이 완성되면 isDone()이 true를 반환한다.
 * stream-json v2에서 Assembler가 별도 export되지 않으므로 직접 구현.
 */
class ValueAssembler {
  private stack: unknown[] = [];
  private keys: string[] = [];
  private done = false;
  private result: unknown = undefined;

  consume(token: Token): void {
    const { name, value } = token;

    switch (name) {
      case 'startObject':
        this.push({});
        break;
      case 'startArray':
        this.push([]);
        break;
      case 'endObject':
      case 'endArray':
        this.pop();
        break;
      case 'keyValue':
        this.keys.push(String(value));
        break;
      case 'stringValue':
        this.addValue(value);
        break;
      case 'numberValue':
        this.addValue(typeof value === 'string' ? Number(value) : value);
        break;
      case 'trueValue':
        this.addValue(true);
        break;
      case 'falseValue':
        this.addValue(false);
        break;
      case 'nullValue':
        this.addValue(null);
        break;
      // startKey, endKey, stringChunk, numberChunk, startString, endString,
      // startNumber, endNumber — 중간 토큰은 무시 (최종 *Value 토큰에서 처리)
    }
  }

  isDone(): boolean {
    return this.done;
  }

  value(): unknown {
    return this.result;
  }

  private push(container: Record<string, unknown> | unknown[]): void {
    if (this.stack.length > 0) {
      this.attach(container);
    }
    this.stack.push(container);
  }

  private pop(): void {
    const completed = this.stack.pop();
    if (this.stack.length === 0) {
      this.result = completed;
      this.done = true;
    }
  }

  private addValue(val: unknown): void {
    if (this.stack.length === 0) {
      // 최상위가 스칼라 값
      this.result = val;
      this.done = true;
      return;
    }
    this.attach(val);
  }

  private attach(val: unknown): void {
    const top = this.stack[this.stack.length - 1];
    if (Array.isArray(top)) {
      top.push(val);
    } else if (top && typeof top === 'object') {
      const key = this.keys.pop();
      if (key !== undefined) {
        (top as Record<string, unknown>)[key] = val;
      }
    }
  }
}

type State =
  | 'IDLE'
  | 'ROOT'
  | 'ASSEMBLING_VALUE'
  | 'CHATS_BEFORE_ARRAY'
  | 'CHATS_ARRAY'
  | 'ASSEMBLING_CHAT';

/**
 * 캐릭터 JSON 파일을 스트리밍 파싱한다.
 *
 * - non-chats 필드: ValueAssembler로 개별 조립하여 fields에 축적
 * - chats 배열: 각 원소를 ValueAssembler로 조립 후 onChat 콜백으로 즉시 전달
 * - SHA-256 해시: 원본 바이트를 Transform으로 통과시키며 동시 계산
 */
export function streamCharacterJson(
  input: Readable,
  onChat: (index: number, chat: Record<string, unknown>) => void,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const hashComputer = crypto.createHash('sha256');
    const fields: Record<string, unknown> = {};

    let state: State = 'IDLE';
    let currentKey = '';
    let chatIndex = 0;
    let asm: ValueAssembler | null = null;

    function processToken(token: Token): void {
      switch (state) {
        case 'IDLE':
          if (token.name === 'startObject') state = 'ROOT';
          break;

        case 'ROOT':
          if (token.name === 'keyValue') {
            currentKey = String(token.value);
            if (currentKey === 'chats') {
              state = 'CHATS_BEFORE_ARRAY';
            } else {
              state = 'ASSEMBLING_VALUE';
              asm = new ValueAssembler();
            }
          }
          break;

        case 'ASSEMBLING_VALUE':
          asm!.consume(token);
          if (asm!.isDone()) {
            fields[currentKey] = asm!.value();
            asm = null;
            state = 'ROOT';
          }
          break;

        case 'CHATS_BEFORE_ARRAY':
          if (token.name === 'startArray') {
            state = 'CHATS_ARRAY';
            chatIndex = 0;
          }
          break;

        case 'CHATS_ARRAY':
          if (token.name === 'endArray') {
            state = 'ROOT';
          } else {
            // 새 chat item 시작
            state = 'ASSEMBLING_CHAT';
            asm = new ValueAssembler();
            asm.consume(token);
          }
          break;

        case 'ASSEMBLING_CHAT':
          asm!.consume(token);
          if (asm!.isDone()) {
            onChat(chatIndex, asm!.value() as Record<string, unknown>);
            chatIndex++;
            asm = null;
            state = 'CHATS_ARRAY';
          }
          break;
      }
    }

    const hashTee = new Transform({
      transform(chunk, _encoding, callback) {
        hashComputer.update(chunk);
        callback(null, chunk);
      },
    });

    const sink = new Writable({
      objectMode: true,
      write(token: Token, _enc, callback) {
        try {
          processToken(token);
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    const pipeline = chain([hashTee, parser()]);
    input.pipe(hashTee);
    pipeline.pipe(sink);

    sink.on('finish', () => {
      resolve({ fields, hash: hashComputer.digest('hex') });
    });

    const onError = (err: Error) => reject(err);
    input.on('error', onError);
    pipeline.on('error', onError);
    sink.on('error', onError);
  });
}
