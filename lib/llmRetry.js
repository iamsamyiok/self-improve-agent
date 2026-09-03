// @name llmRetry
// @desc LLM/外部服务限流与网络抖动的指数退避自动重试（3^n 秒序列：3s→9s→27s→81s）
// 零依赖；供内层 LLM 调用与外层 opencode 会话复用

// 可重试判定：限流（429/402/503 或响应体特征词）与传输网络抖动
const RETRY_STATUS = new Set([429, 402, 503]);
function isRetryableStatus(status) {
  return RETRY_STATUS.has(status);
}
function isRateLimitText(t) {
  return /rate.?limit|too many requests|quota|insufficient|overload|capacity|throttl|限流|频率过高|请求过多/i.test(String(t || ''));
}
// 网络层异常 code（fetch throw 时 e.code）：连接被重置/拒绝、超时、DNS 抖动、管道断裂
const NET_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|UND_ERR|ECONNABORTED)$/;

class RetryableError extends Error {
  constructor(msg) { super(msg); this.name = 'RetryableError'; this.retryable = true; }
}

// 指数退避执行器：fn 抛 RetryableError / 网络 code 错误时按 base*3^n 退避重试
// - baseMs 默认 3000（3s/9s/27s/81s），DUAL_AGENT_RETRY_BASE_MS 可覆盖（测试注入短基数）
// - maxRetries 默认 4（共 1+4=5 次尝试），全部耗尽抛最后一个错误
// - err.retryAfterMs（429 响应 Retry-After 解析值）优先于指数序列（封顶 60s 防服务端异常值）
// - 每次退避加 ±50% 随机抖动：多路子智能体同时 429 后错峰重发，避免同步踩踏（雷群效应）
// - 每次退避经 onEvent({type:'info'}) 通知（前端可见"X 秒后自动重试（第 n/4 次）"）
async function withRetry(fn, opts = {}) {
  const { onEvent, label = 'LLM', maxRetries = 4, maxRetryAfterMs = 60000 } = opts;
  const baseMs = opts.baseMs !== undefined
    ? opts.baseMs
    : Number(process.env.DUAL_AGENT_RETRY_BASE_MS) || 3000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = (e && e.retryable) || (e && e.code && NET_CODES.test(e.code));
      if (!retryable || attempt >= maxRetries) throw e;
      const jitter = 0.5 + Math.random(); // 0.5x-1.5x 均匀抖动
      const wait = Math.max(50, Math.round(
        (e.retryAfterMs !== undefined && e.retryAfterMs > 0)
          ? Math.min(e.retryAfterMs, maxRetryAfterMs)      // 服务端指示优先（封顶可配，默认 60s）
          : baseMs * Math.pow(3, attempt) * jitter         // 指数序列 × 抖动
      ));
      const nth = attempt + 1;
      const reason = String((e && e.message) || e).slice(0, 140);
      if (onEvent) {
        onEvent({
          type: 'info',
          text: `${label}请求被限流/中断（${reason}），${(wait / 1000).toFixed(1)} 秒后自动重试（第 ${nth}/${maxRetries} 次）`
        });
      }
      if (process.env.DUAL_AGENT_DEBUG_RETRY === '1') {
        try {
          const fs = require('fs');
          const path = require('path');
          fs.appendFileSync(
            path.join(process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data'), 'retry-debug.log'),
            `${new Date().toISOString()} ${label} attempt=${nth}/${maxRetries} wait=${wait}ms err=${reason}\n`
          );
        } catch { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// 瞬态错误判定（供任务级重入复用）：限流/网络抖动类可恢复，401/400 配置与参数类不可
function isTransientError(e) {
  return !!(e && ((e.retryable) || (e.code && NET_CODES.test(e.code))));
}

// 任务级自动重入（v0.9.13 病根：withRetry 只覆盖单次 API 调用内的秒级退避，耗尽即上抛
// → SSE error → 整个任务死掉——但 v0.9.12 起历史每轮落盘，任务状态其实完好，缺的只是重入）。
// 重入安全性依据：chatInnerReal 只在单轮 withRetry 完整成功后才把 assistant 消息入列，
// 异常抛出点 messages 尾部必为完整配对（user 或 tool 结果结尾）——正是循环中段的合法状态，
// 重入后模型看到尾部工具结果自然续跑，无需注入任何消息。
// - fn 抛瞬态错误时按 base*2^n 退避（默认 30s/60s/120s，DUAL_AGENT_RESUME_BASE_MS 可覆盖——测试注入短基数）
// - 每次退避经 onInfo 通知（前端可见"X 秒后自动恢复（第 n/3 次），已完成步骤不会重做"）
// - 非瞬态错误（401/400）立即上抛；重入耗尽同样上抛由外层报错
async function withTaskResume(fn, opts = {}) {
  const { onInfo, label = '任务' } = opts;
  const baseMs = Number(process.env.DUAL_AGENT_RESUME_BASE_MS) || 30000;
  const maxResumes = opts.maxResumes !== undefined ? opts.maxResumes : 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!isTransientError(e) || attempt >= maxResumes) throw e;
      const wait = Math.max(50, baseMs * Math.pow(2, attempt));
      const reason = String((e && e.message) || e).slice(0, 140);
      if (onInfo) {
        onInfo({ type: 'info', text: `${label}遭遇网络/限流中断（${reason}），${Math.round(wait / 1000)} 秒后自动恢复重入（第 ${attempt + 1}/${maxResumes} 次）——已完成步骤与历史不丢失，从中断点继续` });
      }
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

module.exports = { withRetry, withTaskResume, isTransientError, RetryableError, isRetryableStatus, isRateLimitText, NET_CODES };
