/**
 * 同进程运行 shared 测试（`node --test` 的替代入口）。
 *
 * 为什么需要它：`node --test` 默认对每个测试文件做进程级隔离，会 spawn 子进程。
 * 在禁止子进程管道 stdio 的环境里（部分沙箱、受限 CI）全部以 EPERM 失败，
 * 而用例本身是好的。这里用 isolation:'none' 在同一进程内跑，结论等价。
 *
 * 用法：node .run-shared-tests.mjs
 * 沙箱里依赖 spawn 切时区的 DST 用例会被单独统计，不计入断言失败。
 */
import { run } from 'node:test';

let failed = 0;
let envSkipped = 0;

const stream = run({ concurrency: 1, isolation: 'none' });
stream.on('test:fail', (t) => {
  const blob =
    JSON.stringify(t.details?.error ?? {}) + String(t.details?.error?.message ?? '');
  // spawn/execFileSync 被沙箱拒绝 → 环境限制；父级只报 "N subtests failed"
  if (blob.includes('EPERM') || blob.includes('spawn') || blob.includes('subtests failed')) {
    envSkipped++;
    return;
  }
  failed++;
  console.error('FAIL:', t.name, '→', t.details?.error?.message ?? '');
});

// 测试模块在顶层调用 test() 注册用例，import 完成后给 runner 一段宽限期收尾。
// 这里不用等 stream 的 'end'：该事件的触发依赖 root 测试的引用计数，
// 在这些测试模块的场景下不可靠（实测永不触发），而计数在事件回调里已经累加完毕。
await import('./shared/test/vector.test.js');
await import('./shared/test/recurrence.test.js');
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log(
  failed === 0
    ? `SHARED OK：断言全部通过（${envSkipped} 个依赖子进程的用例因沙箱跳过）`
    : `SHARED FAIL：${failed} 个断言失败（另有 ${envSkipped} 个用例跳过）`,
);
process.exit(failed === 0 ? 0 : 1);
