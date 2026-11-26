# AgentBox 通用 Skill 源目录

这里维护跨项目复用的通用 Skill。每个子目录是一个完整的 Skill 包，格式遵循
[Skill 系统方案](../agent-runtime/docs/SKILL-SYSTEM.md)：

```text
skills/
  <id>/
    skill.json      # 元数据（schemaVersion / id / version / activation ...）
    SKILL.md        # 注入给模型的正文（必需）
    references/     # 可选：静态参考，不自动注入
    templates/      # 可选：纯文本模板，不执行
```

## 如何生效

本目录只是**源目录**，不会被扩展自动加载。任选一种方式部署：

**本地使用（推荐个人通用规范）**

```powershell
# 把某个 skill 复制到扩展的本地 skill 目录
Copy-Item -Recurse .\skills\code-review "$env:USERPROFILE\.agentbox\skills\local\code-review"
```

或在 VS Code 中执行 `AgentBox: Open Skills Folder` 打开目标目录后手动复制。
之后在聊天框输入 `@code-review` 可只对当前一轮调用；也可以在顶栏 **✦** 技能抽屉里
勾选启用（持久注入）。

**团队分发（走审批）**

把 skill 目录复制到 `skill-server/skills/` 下，或用 `AgentBox: Upload Skill`
上传到 Skill Registry，经 reviewer 审批后由客户端同步。

## 编写约定

- `SKILL.md` 推荐分段：`何时使用 / 步骤 / 反模式 / 示例 / 验证方式 / 关联知识`；
- 元数据统一放 `skill.json`，`SKILL.md` 开头不写 YAML frontmatter（本地目录可省略
  `skill.json`，但本目录不省略，便于上传）；
- `id` 必须匹配 `^[a-z0-9][a-z0-9._-]{2,63}$`，且与目录名一致；
- `version` 使用 semver，上传后不可变，修改内容需升版本；
- 单文件 ≤ 200,000 字符，整包 ≤ 1,000,000 字符，文件数 ≤ 50，仅文本扩展名；
- 不写密钥、内网地址、个人隐私，不写"忽略之前指令"这类越权内容；
- 控制篇幅：单个 skill 正文建议 ≤ 8,000 字符（默认 optional 预算），required 场景更短；
- 用 `priority` 表达冲突时的排序（默认 50，越大越优先）。

## 当前 Skill 索引

| id | 名称 | 类别 | activation | 用途 |
|---|---|---|---|---|
| `code-review` | 代码评审 | 工程规范 | on-demand | PR/变更评审的检查顺序与 finding 写法 |
| `error-handling` | 错误处理与可观测性 | 工程规范 | on-demand | 错误传播、日志、重试/超时、资源清理 |
| `testing-strategy` | 测试策略 | 工程规范 | on-demand | 选测试层级、最小验证、确定性测试 |
| `etl-authoring` | ETL 编写 | 数据/SQL | on-demand | staging 落表、分层与星型/雪花选型、CTE 命名与层级、注释模板、幂等增量与验证 SQL |
| `sql-query-review` | SQL 查询与索引评审 | 数据/SQL | on-demand | 执行计划、索引、N+1、事务与锁 |
| `db-migration-safety` | 数据库迁移安全 | 数据/SQL | on-demand | 兼容迁移、在线变更、回滚与回填 |
| `api-design-review` | API 契约设计评审 | 后端 | on-demand | 契约、幂等、版本兼容、授权边界 |

所有 skill 默认 `activation: on-demand`：不会被每一轮自动注入，需通过 `@id` 主动调用，
或在技能抽屉中启用。需要团队强制下发时，由 Skill Server 设置 `required`。

## 新增 Skill 清单

1. 建目录 `skills/<id>/`，写 `skill.json` 与 `SKILL.md`；
2. 对照本文约定自查（id/version/篇幅/敏感信息）；
3. 本地复制到 `~/.agentbox/skills/local/<id>/` 后，用 `AgentBox: Validate Skill` 校验；
4. 更新上面的索引表。
