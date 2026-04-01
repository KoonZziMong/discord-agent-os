/**
 * utils.ts — 공통 유틸리티
 *
 * keepTyping   : Discord "입력 중..." 표시를 응답 완료까지 유지.
 *                Discord typing indicator는 10초 후 자동 소멸하므로 8초마다 재호출.
 * splitMessage : Discord 2000자 제한 대응. 코드블록이 중간에 잘리지 않도록 처리.
 * sendSplit    : splitMessage를 적용하여 채널에 순서대로 전송.
 * getErrorMessage : Anthropic API 에러를 사용자 친화적 메시지로 변환.
 *                   Rate limit(429)과 서버 오류(5xx)는 retryAfter 반환 → agent.ts에서 재시도.
 * delay        : Promise 기반 단순 대기.
 */
import type { TextChannel, DMChannel, NewsChannel, ThreadChannel, Message } from 'discord.js';

export type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

/** ms 동안 대기 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discord "입력 중..." 표시를 응답이 완료될 때까지 유지합니다.
 *
 * Discord typing indicator는 약 10초 후 자동으로 사라지므로,
 * 8초마다 sendTyping()을 반복 호출하여 계속 표시되도록 합니다.
 *
 * 사용법:
 *   const stopTyping = keepTyping(channel);
 *   try {
 *     const result = await someAsyncWork();
 *   } finally {
 *     stopTyping(); // 반드시 호출해야 인터벌이 정리됩니다
 *   }
 *
 * @returns stopTyping — 호출하면 반복을 중단하고 "입력 중..." 표시가 사라집니다
 */
export function keepTyping(channel: SendableChannel): () => void {
  // 즉시 한 번 호출하여 바로 표시
  (channel as TextChannel).sendTyping().catch(() => {});

  // 8초마다 재호출 (Discord 10초 타임아웃보다 짧게)
  const interval = setInterval(() => {
    (channel as TextChannel).sendTyping().catch(() => {});
  }, 8_000);

  // 반환된 함수를 호출하면 인터벌 정리
  return () => clearInterval(interval);
}

/**
 * Discord 2000자 제한 대응 메시지 분할.
 * 코드블록(```) 중간에서 잘리지 않도록 처리.
 */
export function splitMessage(text: string, maxLength = 1990): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(inCodeBlock ? remaining + '\n```' : remaining);
      break;
    }

    let chunk = remaining.slice(0, maxLength);

    // 코드블록 시작/종료 추적
    const codeBlockMatches = chunk.match(/```/g) ?? [];
    const toggleCount = codeBlockMatches.length;

    // 코드블록 중간에서 잘리는지 확인
    const lastTriple = chunk.lastIndexOf('```');
    const isInsideBlock = toggleCount % 2 !== 0;

    let cutPoint: number;

    if (isInsideBlock) {
      // 마지막 ``` 이전에서 자름
      cutPoint = lastTriple > 0 ? lastTriple : chunk.lastIndexOf('\n');
    } else {
      // 줄 바꿈 기준으로 자름
      cutPoint = chunk.lastIndexOf('\n');
    }

    if (cutPoint <= 0) cutPoint = maxLength;

    chunk = remaining.slice(0, cutPoint);

    // 코드블록 열고 닫기 균형 맞추기
    const openCount = (chunk.match(/```/g) ?? []).length;
    const needClose = openCount % 2 !== 0;

    if (needClose) {
      // 어떤 언어로 열었는지 찾기
      const langMatch = chunk.match(/```(\w*)\n/);
      codeBlockLang = langMatch ? langMatch[1] : '';
      parts.push(chunk + '\n```');
    } else {
      parts.push(chunk);
    }

    remaining = remaining.slice(cutPoint);

    // 다음 청크에서 코드블록 재개
    if (needClose && remaining.length > 0) {
      remaining = `\`\`\`${codeBlockLang}\n` + remaining.trimStart();
      inCodeBlock = true;
    } else {
      inCodeBlock = false;
    }
  }

  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Discord 채널에 splitMessage를 적용하여 전송.
 * 각 파트 사이 짧은 딜레이로 순서 보장.
 */
export async function sendSplit(
  channel: SendableChannel,
  text: string,
): Promise<void> {
  const parts = splitMessage(text);
  for (const part of parts) {
    await (channel as TextChannel).send(part);
    if (parts.length > 1) await delay(300);
  }
}

/**
 * API 에러 처리.
 * Rate Limit(429): 5초 후 재시도 신호 반환.
 * 기타: 사용자 친화적 메시지 반환.
 */
export function getErrorMessage(err: unknown): { message: string; retryAfter?: number } {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
      return { message: '⏳ 요청이 너무 많습니다. 잠시 후 다시 시도할게요.', retryAfter: 5000 };
    }
    if (msg.includes('5') && msg.match(/5\d\d/)) {
      return { message: '⚠️ AI 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도할게요.', retryAfter: 3000 };
    }
    if (msg.includes('401') || msg.includes('invalid_api_key')) {
      return { message: '❌ API 키가 유효하지 않습니다. 관리자에게 문의하세요.' };
    }
    return { message: `❌ 오류가 발생했습니다: ${msg.slice(0, 100)}` };
  }
  return { message: '❌ 알 수 없는 오류가 발생했습니다.' };
}
