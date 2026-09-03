// 多路 LLM API 配置（v0.9.6）：子智能体并行派生时轮转选择 profile，
// 把并发请求分摊到多个 OpenAI 兼容端点，避免单端点速率限制（429）互相挤兑。
// 设计：配置存 .data/config.json 的 inner_profiles 数组（可选）；
// 无有效条目时回退主配置（cfg.inner），行为与旧版完全一致。

// 过滤有效 profile：base_url / api_key / model 三项齐全才算数（防手改 JSON 埋雷）
function validProfiles(cfg) {
  const arr = Array.isArray(cfg && cfg.inner_profiles) ? cfg.inner_profiles : [];
  return arr
    .filter(p => p && typeof p === 'object' && !Array.isArray(p))
    .filter(p => String(p.base_url || '').trim() && String(p.api_key || '').trim() && String(p.model || '').trim())
    .map((p, i) => ({
      name: String(p.name || `profile-${i + 1}`).slice(0, 30),
      base_url: String(p.base_url).trim(),
      api_key: String(p.api_key).trim(),
      model: String(p.model).trim()
    }));
}

// 轮转选择：rr 为共享计数器对象 {n}（跨子任务递增）；有 profiles 轮转取，
// 无则回退主配置。返回 { cfg, name, rotated } —— cfg 形状与 cfg.inner 一致
function pickProfile(cfg, rr) {
  const profiles = validProfiles(cfg);
  if (!profiles.length) {
    return { cfg: cfg.inner, name: 'main', rotated: false };
  }
  const idx = (rr.n++) % profiles.length;
  const p = profiles[idx];
  return { cfg: { base_url: p.base_url, api_key: p.api_key, model: p.model }, name: p.name, rotated: true };
}

module.exports = { validProfiles, pickProfile };
