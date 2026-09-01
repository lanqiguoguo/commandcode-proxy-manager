// ── 共享令牌比较（P1-3）：常量时间字符串比较 ─────────────────
// `===` 短路比较理论上存在时序侧信道；先各自做 SHA-256 摘要
// （消除长度泄漏 + 定长化），再用 crypto.timingSafeEqual 比较。
// 任一入参非 string（header/cookie 缺失时为 undefined）一律返回 false。
import crypto from "crypto";

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
