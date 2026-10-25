// sp-transitions.js — **壳自有**的转场 helper（2026-10-25 上游 0.3.3 同步后拆出）。
//
// 为什么不直接在 ui/transitions.js 上改：上游 0.3.2 起引入了同名文件
// public/js/ui/transitions.js（只有 useRise），我们的旧副本顶住它会静默丢掉上游实现
// （门禁 check-extras-overlap 的 B5/R-14）。按「上游优先覆盖」口径：上游那份进 webroot，
// 我们**多出来的**三个 helper（useLeave/afterLeave/usePresence）搬到这里，用 sp- 前缀
// 避免同名覆盖。useRise 继续用上游版本（签名向后兼容：value, ms, fresh）。
//
// 关键帧在 css/screens/lobby.css（tr-*）；这些 hook 只负责「离场动画播完再卸载」。
// prefers-reduced-motion 下不等待。
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { reducedMotion } from './device.js';

/** How long a full-screen overlay takes to leave (its content fades, then the black lifts off what is below). */
export const LEAVE_MS = 300;

/**
 * [leaving, leave]: leave() marks the view as leaving (class is-leaving fades it out) and calls `done` once that has
 * played; a second call while leaving is ignored.
 * @param {() => void} done @param {number} [ms]
 */
export function useLeave(done, ms = LEAVE_MS) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = () => {
    if (timer.current) return;
    if (reducedMotion()) { doneRef.current(); return; }
    setLeaving(true);
    timer.current = setTimeout(() => doneRef.current(), ms);
  };
  return [leaving, leave];
}

/** Resolves once a leaving animation of `ms` has played (at once with reduced motion). @param {number} [ms] */
export function afterLeave(ms = LEAVE_MS) {
  return new Promise((resolve) => { setTimeout(resolve, reducedMotion() ? 0 : ms); });
}

/**
 * Keeps a view mounted for `ms` after `show` turns false so its leaving animation can play: [mounted, leaving].
 * @param {boolean} show @param {number} [ms]
 */
export function usePresence(show, ms = 220) {
  const [kept, setKept] = useState(!!show);
  useEffect(() => {
    if (show) { setKept(true); return undefined; }
    if (!kept) return undefined;
    if (reducedMotion()) { setKept(false); return undefined; }
    const id = setTimeout(() => setKept(false), ms);
    return () => clearTimeout(id);
  }, [!!show]);
  return [!!show || kept, !show && kept];
}
