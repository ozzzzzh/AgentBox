# Skill Server 通讯与 Required 机制验证方案

> 目标：验证 AgentBox 扩展与 `skill-server` 的完整通讯闭环，以及
> `required` skill 是否真正不可关闭、不可被本地同名 skill 覆盖、在离线/缓存/撤销场景下行为正确。
>
> 前置：本地 skill 已验证可用；本文只覆盖 remote registry + required 注入。
> 相关实现：`extension/src/skills/*`、`extension/src/skill-commands.ts`、`skill-server/`。

---

## 1. 测试环境

### 1.1 启动 Skill Server

最简方式（开发模式，自动生成开发 token）：

```powershell
cd skill-server
npm install
npm run dev
```

控制台会打印：

```text
dev-reader -> reader
dev-author -> author
dev-reviewer -> reviewer
dev-admin -> admin
```

管理页/扩展填 `dev-admin` 即可。

手动方式：

```powershell
$env:PORT = "4770"
$env:SKILL_SERVER_DATA = "D:\agentbox-skill-data"
$env:SKILL_SERVER_TOKENS = '{"my-reader":"reader","my-author":"author","my-reviewer":"reviewer","my-admin":"admin"}'
npm start
```

- `SKILL_SERVER_DATA`：数据持久化目录（index/policies/audit/packages）。
- `SKILL_SERVER_TOKENS`：token → 角色；key 是自己定的密码，value 是角色。
- 管理页登录 token = value 为 `admin` 的那个 key（上面示例是 `my-admin`）。

验证：

```powershell
curl.exe http://127.0.0.1:4770/healthz
# {"ok":true}

curl.exe -H "authorization: Bearer reader-token" http://127.0.0.1:4770/v1/skills
# 200 {"skills":[]}
```

### 1.2 扩展配置

在工作区 `.vscode/settings.json` 或设置 UI 中配置：

```json
{
  "agentbox.skills.serverUrl": "http://127.0.0.1:4770",
  "agentbox.skills.autoSync": true,
  "agentbox.skills.requiredMissing": "warn",
  "agentbox.skills.enabled": [],
  "agentbox.skills.disabled": []
}
```

Token 通过命令面板 **AgentBox: Set Skill Server Token** 写入 SecretStorage，
不要写进 settings。

### 1.3 测试包

准备 5 个本地 skill：

| 包 | 用途 |
|---|---|
| `team-required` | 将由 admin 设为 required |
| `team-optional` | 普通 approved remote skill |
| `team-rejected` | 上传后 reject，验证不可见 |
| `team-required`（本地同名） | 验证 remote required 覆盖 local |
| `team-large` | 超过 budget，验证截断 |

`SKILL.md` 内容要包含唯一 marker，便于在 `AgentBox Chat` / developerInstructions
里搜索：

```md
# team-required
MARKER_REMOTE_REQUIRED
```

---

## 2. 验证矩阵

### A. Server 基础通讯 / 权限

| ID | 步骤 | 期望 |
|---|---|---|
| SV-A1 | `GET /healthz` 无 token | `200 {"ok":true}` |
| SV-A2 | `GET /v1/skills` 无 token | `401` |
| SV-A3 | `GET /v1/skills` + reader-token | `200`，空列表 |
| SV-A4 | `POST /v1/skills` + reader-token | `403`（reader 不能上传） |
| SV-A5 | `POST /v1/skills` + author-token | `201`，`status:"pending"` |
| SV-A6 | `GET /v1/skills` + reader-token | 看不到 pending |
| SV-A7 | `GET /v1/skills?status=pending` + reviewer-token | 看到 pending |
| SV-A8 | 错误 token | `401` |
| SV-A9 | `x-agentbox-user: alice` 上传 | audit 记录 actor=alice |

### B. 审批 / 版本不可变 / 撤销

| ID | 步骤 | 期望 |
|---|---|---|
| SV-B1 | reviewer 审批 pending | `200`，status=approved |
| SV-B2 | 同一 `id@version` 再次上传 | `400`，版本不可变 |
| SV-B3 | 上传 `1.0.1` 并审批 | 新版本独立可见 |
| SV-B4 | reader 下载未审批版本 | `404` |
| SV-B5 | reviewer 下载未审批版本 | `200`（reviewer 可预览） |
| SV-B6 | uploader 用 reviewer token 审批自己的包 | `403 SELF_REVIEW` |
| SV-B7 | admin 审批同一包 | `200`（admin 可越权） |
| SV-B8 | reject | 之后 reader 下载 `404` |
| SV-B9 | revoke 已 approved 版本 | reader 下载 `404`，`/v1/required` 不再返回 |
| SV-B10 | server 重启 | 数据仍在（index/policies/audit 持久化） |

### C. Required 策略

| ID | 步骤 | 期望 |
|---|---|---|
| SV-C1 | 对 pending 版本 `PUT /v1/skills/:id/policy` | `400`，未审批不能 required |
| SV-C2 | 审批后设置 `{required:true,version:"1.0.0",target:"all"}` | `200` |
| SV-C3 | `GET /v1/required` + reader | 返回该 skill，`required:true` |
| SV-C4 | 再审批 `1.0.1`，policy 仍指向 `1.0.0` | required 仍是 `1.0.0` |
| SV-C5 | 设置 `{required:false,version:"1.0.0"}` | `/v1/required` 不再返回 |
| SV-C6 | 删除/撤销 required 版本 | `/v1/required` 不返回 |

> 当前 MVP 约定 `target:"all"`。`target != all` 的客户端过滤尚未实现，
> 见 §5 已知缺口。

### D. 客户端同步 / 缓存 / hash

| ID | 步骤 | 期望 |
|---|---|---|
| SV-D1 | 设置 serverUrl + token，执行 **AgentBox: Sync Remote Skills** | 提示“已同步 N 个，其中 required M 个” |
| SV-D2 | 检查 `<globalStorage>/agentbox/skills/remote/<serverHash>/index.json` | 含 id/version/required/hash |
| SV-D3 | 检查缓存目录 | 每个包有 `skill.json` + `SKILL.md` |
| SV-D4 | 篡改缓存 `SKILL.md` 后重新 sync | 被覆盖；sync 前 hash 不匹配会 warning |
| SV-D5 | 服务端下载 hash 与 index hash 不一致 | sync warning，不写入该包 |
| SV-D6 | server 不可达 | 命令报错；已有缓存保留；下一条 prompt 仍可用缓存 |
| SV-D7 | `autoSync=true` 且 token 存在，Reload Window | 激活时自动 sync |
| SV-D8 | `autoSync=true` 但无 token | 不发起请求，不阻塞启动 |
| SV-D9 | `autoSync=false` | 激活不 sync，只能手动命令 |

### E. Required 客户端强制机制

| ID | 步骤 | 期望 |
|---|---|---|
| SV-E1 | 打开技能抽屉 | required 行显示锁图标，checkbox 选中且 `disabled` |
| SV-E2 | 点击 required 行 | 不发送 `skills.toggle`，状态不变 |
| SV-E3 | 手工在 settings 写 `skills.disabled:["team-required"]` | required 仍注入；catalog 仍 active |
| SV-E4 | 本地存在同名 `team-required` | remote required 覆盖 local；local 不出现在 catalog；日志有覆盖 warning |
| SV-E5 | `@team-required` mention | required 已注入，mention 不重复注入 |
| SV-E6 | `@team-required` 在 cache 缺失时 | 不能变成普通 optional；应保持 required 语义或报错 |
| SV-E7 | required 与 optional 同时存在 | `requiredText` 在 developer instructions 的前部；optional 在后部 |
| SV-E8 | required 超过 budget | 按 priority 排序，超出时截断/跳过并 warning |
| SV-E9 | required 优先级高于 local | local 同名被跳过，日志可见 |
| SV-E10 | required skill 被 revoke 后 sync | 下一条 prompt 不再注入；cache/index 不再有 required |
| SV-E11 | admin 在管理页点「停止推送」 | `/v1/skills?status=approved` 返回 `enabled:false`；客户端 sync 跳过；required 同时失效 |
| SV-E12 | admin 点「推送给 Agent」 | 客户端下次 sync 后恢复缓存；若 required 仍为 true 则重新注入 |
| SV-E13 | 客户端在 Skill Groups 多选并提交申请 | server 记录 pending；admin 页面“加入申请”可见 |
| SV-E14 | admin 通过申请后客户端 sync | 该组 required/optional skill 可见；未加入组仍不可见 |
| SV-E15 | 未分组 skill（`general-style`） | 不加入任何组也能同步 |
| SV-E16 | 同时申请多个组 | 每个组独立审批；全部通过后对应 skill 都可见 |

### F. requiredMissing / 离线 / 缓存

| ID | 步骤 | 期望 |
|---|---|---|
| SV-F1 | 清空 remote 缓存，`requiredMissing=warn` | 下一条 prompt 继续，`AgentBox Chat` 有“远程 skill 尚未同步”warning |
| SV-F2 | 清空 remote 缓存，`requiredMissing=block` | 下一条 prompt 启动失败，明确提示先 sync |
| SV-F3 | server 停机，已有缓存 | 继续使用缓存；required 仍注入 |
| SV-F4 | server 停机，无缓存，block | 阻断 |
| SV-F5 | required 包下载失败但 index 仍写入 | **当前可能不阻断**，见 §5 缺口 |
| SV-F6 | required 版本被 revoke 但客户端未 sync | 继续使用旧缓存（预期），直到 sync；记录此语义 |

### G. 安全 / 校验 / 审计

| ID | 步骤 | 期望 |
|---|---|---|
| SV-G1 | 上传含 `../`、绝对路径、隐藏文件 | `400`，不落盘 |
| SV-G2 | 上传不允许的扩展名/超大文件 | `400` |
| SV-G3 | 上传非法 id/version | `400` |
| SV-G4 | 本地 `skill.json` 写 `required:true` | 客户端忽略，仍为 optional |
| SV-G5 | token 是否出现在 Webview/settings/log | 不出现；只在 SecretStorage |
| SV-G6 | audit | upload/approve/reject/revoke/policy 都有 actor/time |
| SV-G7 | 并发上传同一版本 | 一个成功，一个 `400`，不产生半包 |
| SV-G8 | 服务端数据目录损坏/半写入 | 启动失败或明确错误，不静默丢数据 |

### H. 端到端（Codex 注入）

| ID | 步骤 | 期望 |
|---|---|---|
| SV-H1 | 配置 required + optional，发一条普通 prompt | `AgentBox Chat` 输出 `[skill] injected: team-required@...` |
| SV-H2 | 检查 `developerInstructions` | 含 `[skill team-required@1.0.0]` 唯一 marker |
| SV-H3 | 禁用 optional，required 保留 | optional 不注入，required 仍注入 |
| SV-H4 | 离线重启 + 缓存 | required 仍注入 |
| SV-H5 | block + 无缓存 | turn 不启动，UI 显示错误 |
| SV-H6 | 长 required 包 | 不超预算；日志有截断 warning |

---

## 3. 自动化测试建议

### 已有

- `skill-server/tests/server.test.cjs`：9 个（health、pending→approve、required policy、self-review、reject/revoke）。
- `extension/tests/skills-*.spec.ts`：client/store/injection/catalog/mentions。

### 需要补

1. **真实 HTTP 集成测试**：启动 `createSkillServer({port:0})`，用 `SkillServerClient`
   上传→审批→设置 required→sync→`readRemoteSkills`，不 mock fetch。
2. **requiredMissing**：
   - 无 index + warn/block；
   - 有 index 但 required 包缺失 + block（当前预期 fail，见缺口）。
3. **客户端 target 过滤**：
   - server policy target=workspaceA；workspaceB sync 不应标记 required。
4. **多版本**：
   - 同一 id 多个 approved 版本；required 只指向 policy 版本；
   - 可选 remote 不重复注入。
5. **mention + required**：
   - required 已注入时 mention 不重复；
   - required 未同步时 mention 不降级。

---

## 4. 手工验证脚本建议

```powershell
$base = "http://127.0.0.1:4770"

# 1. 上传
curl.exe -sS -X POST "$base/v1/skills" `
  -H "authorization: Bearer author-token" `
  -H "content-type: application/json" `
  -H "x-agentbox-user: alice" `
  --data-binary "@team-required.json"

# 2. 审批
curl.exe -sS -X POST "$base/v1/skills/team-required/1.0.0/approve" `
  -H "authorization: Bearer reviewer-token" `
  -H "x-agentbox-user: bob" `
  -H "content-type: application/json" `
  -d '{\"comment\":\"ok\"}'

# 3. 设为 required
curl.exe -sS -X PUT "$base/v1/skills/team-required/policy" `
  -H "authorization: Bearer admin-token" `
  -H "content-type: application/json" `
  -d '{\"required\":true,\"version\":\"1.0.0\",\"target\":\"all\"}'

# 4. 客户端：Sync Remote Skills，然后发 prompt
```

---

## 5. 当前已知缺口（验证前先确认）

1. **`target` 未生效**  
   `syncRemoteSkills()` 调用 `/v1/skills?status=approved`，`SkillSummary.required`
   只来自 policy version，**没有按 workspace/target 过滤**。  
   如果产品需要“只对某团队/某 workspace required”，需要：
   - 客户端传 `target`（workspace id）到 `/v1/skills` 和 `/v1/required`；
   - 或服务端按 token/actor 计算 target。

2. **requiredMissing 只检查“有没有 index”**  
   如果 sync 部分失败、required 包下载失败但 index 写入，`requiredMissing=block`
   不会阻断。建议在 `readSkillsForInjection` 中：
   - 读取 `/v1/required` 或 index 的 required 列表；
   - 检查缓存中每个 required id/version 是否存在且 hash 匹配；
   - 缺失时按 `requiredMissing` warn/block。

3. **autoSync 只在扩展激活时执行**  
   server 端 policy 变更后，当前会话不会自动感知；需要手动 **Sync Remote Skills**
   或增加定时/命令触发。

4. **多版本去重**  
   `/v1/skills?status=approved` 返回同一 id 的多个 approved 版本；客户端会全部缓存。
   需要明确：可选 skill 只注入最新版本，还是 policy 指定版本。

5. **mention 的 required 标记**  
   `buildMentionedSkillContext` 对 mention 的 usage 固定 `required:false`；
   如果 required 未进入被动注入而通过 mention 注入，语义会降级。建议 mention
   先按 required 集合判定。

---

## 6. 验收标准

- A–H 矩阵全部通过，或缺口有明确 issue/记录。
- server 与 extension 的集成测试不依赖 mock fetch。
- required 在 UI、settings、mention、离线、revoke 场景下都不能被关闭/覆盖。
- 注入的 skill id@version/hash 可在 `AgentBox Chat` 审计。
- 失败场景（无缓存、hash 错、未审批、revoke、server 停机）有明确提示，不静默。
