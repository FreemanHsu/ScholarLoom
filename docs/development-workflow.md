# Development workflow

ScholarLoom 使用轻量的 trunk-based development。`main` 是唯一长期分支；功能、修复和
架构调整均从最新 `main` 创建短生命周期的 `codex/*` 分支，并通过 Pull Request 回到主线。
不设置长期 `develop` 分支。

## 分支职责

- `main`：当前认可的生产基线，必须始终可运行、可恢复。
- `codex/<scope>`：一个明确目标对应一个分支，例如 `codex/backup-automation` 或
  `codex/fix-import-timeout`。
- 分支合并后删除本地和远端副本；后续工作从更新后的 `main` 新建分支，不在已合并分支上
  继续堆叠任务。

## 标准流程

```bash
git switch main
git pull --ff-only
git switch -c codex/<scope>

# implementation and verification

git push -u origin codex/<scope>
```

推送后创建以 `main` 为 base 的 Pull Request。优先使用 squash merge；如果分支本身已经是
单一、语义完整的提交，可以使用 rebase merge。不要为线性历史额外制造 merge commit。

## 回主线门槛

合并以“可安全成为下一生产基线”为标准，而不是仅以代码完成为标准：

1. 变更范围符合已接受的 PRD、architecture 和 ADR，且 review 没有未解决的 hard finding。
2. `npm test`、`npm run typecheck`、`npm run build` 和 `git diff --check` 全部通过。
3. Storage 变更完成真实 snapshot verification，并 restore 到新的临时 data root。
4. Browser 变更完成真实 Playwright journey。
5. 数据迁移具有已验证的回滚点，生产候选代码启动后 diagnostics 为 healthy。
6. 分支已吸收最新 `main`，Pull Request 中没有未解决的 review conversation。

## 主线保护与紧急修复

远端 `main` 禁止 force push 和删除，使用线性历史，并要求通过 Pull Request 合并。个人项目
允许零审批合并，但所有自动检查和 review conversation 必须先解决。

紧急修复仍从 `main` 创建 `codex/hotfix-<scope>`，完成与风险相称的验证后通过 Pull Request
合并。只有 GitHub 或 Pull Request 机制不可用、且生产恢复不能等待时，仓库所有者才可采用
break-glass direct push；事后必须补充原因、验证记录和必要 ADR。
