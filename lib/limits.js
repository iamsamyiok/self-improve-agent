// lib/limits.js — Agnes 模型上下文预算中心（v3.5）
// 实测依据（2026-09-04，agnes-2.5-flash）：窗口 524288 tokens（512K）——
// 700K 字符输入通过（prompt_tokens=500290），760K 字符被拒且错误消息明确给出
// "context length (524288 tokens)"。中文为主场景实测 ≈0.72 token/字符（1.39 字符/token）。
// 所有「喂给 LLM 的字符限制」以本模块为唯一基准：上限 = 窗口 × 80%（预留 20% 空闲
// 给模型输出、token 计入误差与安全余量）。
const CTX_TOKENS = 524288;
const SAFE_RATIO = 0.8;
const INPUT_BUDGET_TOKENS = Math.floor(CTX_TOKENS * SAFE_RATIO); // 419,430 tokens
const CHARS_PER_TOKEN = 1.39;                                    // 中文为主实测换算
const INPUT_BUDGET_CHARS = Math.floor(INPUT_BUDGET_TOKENS * CHARS_PER_TOKEN); // ≈583,000 字符

module.exports = { CTX_TOKENS, SAFE_RATIO, INPUT_BUDGET_TOKENS, CHARS_PER_TOKEN, INPUT_BUDGET_CHARS };
