# Skill Registry Server

HTTP service for the AgentBox Skill system. It stores immutable skill versions,
supports review/approval, and lets admins mark approved versions as required.

## Run

### 本地开发（推荐先这样跑）

```powershell
cd skill-server
npm install
npm run dev
```

`npm run dev` 会：

- 构建服务；
- 自动设置 `PORT=4770`、`SKILL_SERVER_DATA=.dev-data`；
- 使用开发 token；
- 在控制台打印每个 token 和角色。

然后打开：

```text
http://127.0.0.1:4770/admin
```

开发模式管理页会**自动登录**（`dev-admin`），不需要手动填 token。
`dev-*` token 只用于本机开发；扩展在 loopback dev server 上可以匿名读取，不需要 token。

写入示例 skills（两种方式）：

| 方式 | 命令 | 是否需要服务已启动 | 是否需要 token |
|---|---|---|---|
| **直接写本地数据（推荐测试）** | `npm run dev:seed` | 否，会自动启动 | 否 |
| 直接写本地数据，但自己启服务 | `npm run seed:local` 后 `npm start` | 否 | 否 |
| 通过 HTTP 注册到运行中的服务 | `npm run seed` | 是 | 是，需要 admin token |

推荐直接用：

```powershell
npm run dev:seed
```

它会：

1. 构建服务；
2. 把 4 个 skill 直接写入 `.dev-data`；
3. 启动服务。

然后管理页 `http://127.0.0.1:4770/admin` 用 `dev-admin`；
扩展连接用 `dev-reader` 或 `dev-admin`。

写入内容：

| id | 状态 |
|---|---|
| `team-encoding` | approved + required |
| `sql-etl` | approved + optional |
| `frontend-style` | pending，用于验证审核 |
| `security-checklist` | approved + 未推送，用于验证推送开关 |
| `general-style` | 未分组，验证未加入组也能拿到的内容 |

同时创建 3 个分组：`backend`（team-encoding/sql-etl）、`security`（security-checklist）、`frontend`（frontend-style）。

`seed:local` / `dev:seed` 直接写文件，不需要 token。
如果服务已经在运行，先停掉再执行，否则服务内存里的 index 不会刷新。

通过 HTTP 注册（服务已运行）时才用：

```powershell
$env:SKILL_SERVER_ADMIN_TOKEN = "my-admin"
npm run seed
```

或让 seed 自动从同一个终端的 `SKILL_SERVER_TOKENS` 取 admin：
```powershell
$env:SKILL_SERVER_TOKENS = '{"my-admin":"admin"}'
npm run seed
```

### 手动启动

```powershell
cd skill-server
npm install
npm run build

$env:PORT = "4770"
$env:SKILL_SERVER_DATA = "D:\agentbox-skill-data"
$env:SKILL_SERVER_TOKENS = '{"my-reader":"reader","my-author":"author","my-reviewer":"reviewer","my-admin":"admin"}'
npm start
```

### 两个环境变量到底是什么意思

| 变量 | 含义 | 示例 |
|---|---|---|
| `SKILL_SERVER_DATA` | Skill 数据的**持久化目录**。服务会在里面写 `index.json`、`policies.json`、`audit.jsonl`、`packages/`。删掉它就等于清空 registry；生产环境要备份。 | `D:\agentbox-skill-data` |
| `SKILL_SERVER_HOSTNAME` | 监听地址，默认 `127.0.0.1`（仅本机）。放到反向代理后面时才改成 `0.0.0.0`。 | `127.0.0.1` |
| `SKILL_SERVER_TOKENS` | **token → 角色** 的 JSON 对象。key 是你自己定的 token 字符串（相当于密码），value 是角色：`reader` / `author` / `reviewer` / `admin`。服务不会生成 token；你写什么 key，客户端/管理页就填什么。 | `{"dev-admin":"admin"}` 里的 `dev-admin` 就是 admin token |

角色是等级关系：

```text
admin > reviewer > author > reader
```

`admin` token 也能读取、审批、上传；管理页面需要 **admin 或 reviewer** token
才能看到 pending/全部版本。`reviewer` 不能审批自己上传的版本（admin 可以）。

> `SKILL_SERVER_TOKENS` 的 key 会作为 Bearer token 明文传输（本地 HTTP）；
> 生产必须放 TLS 反向代理后面，并使用足够长的随机 token。

### 管理页面

`http://127.0.0.1:4770/admin` 现在包含：

- token 登录 / 角色显示 / 退出；
- 待审批、已批准、必选、全部、分组、审计六个视图；
- 搜索、状态筛选、统计；
- 通过/拒绝（可填备注）、设为必选/取消必选、推送给 Agent/停止推送、撤销；
- 分组管理：创建/编辑/删除分组，勾选成员 skill；
- 查看完整 skill 包内容；
- 审计日志。

登录 token 就是 `SKILL_SERVER_TOKENS` 里 value 为 `admin`（或 `reviewer`）的那个 key。

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/healthz` | public | health check |
| GET | `/v1/me` | any authenticated | current actor/role |
| GET | `/v1/skills?status=approved` | reader | approved list |
| GET | `/v1/skills?status=pending` | reviewer/admin | review queue |
| GET | `/v1/skills/:id` | reader | versions |
| GET | `/v1/skills/:id/:version` | reader (approved) / reviewer | package JSON |
| GET | `/v1/required` | reader | required approved skills |
| GET | `/v1/groups` | reader | skill groups |
| GET | `/v1/client/groups` | reader | groups with client membership status (requires `x-agentbox-client`) |
| POST | `/v1/client/groups/:id/request` | reader | request to join a group |
| GET | `/v1/group-requests` | admin | pending group join requests |
| POST | `/v1/group-requests/:clientId/:groupId` | admin | approve/reject a join request |
| PUT | `/v1/groups/:id` | admin | create/update a group and its skillIds |
| DELETE | `/v1/groups/:id` | admin | delete a group |
| POST | `/v1/skills` | author | upload a new version; status becomes `pending` |
| POST | `/v1/skills/:id/:version/approve` | reviewer | approve |
| POST | `/v1/skills/:id/:version/reject` | reviewer | reject |
| POST | `/v1/skills/:id/:version/revoke` | admin | revoke an approved version |
| PUT | `/v1/skills/:id/policy` | admin | set `required` / `enabled` / version / target |
| GET | `/v1/audit` | admin | audit log |

Upload body is the package sent by the extension:

```json
{
  "manifest": { "schemaVersion": 1, "id": "team-encoding", "version": "1.0.0" },
  "files": { "SKILL.md": "# ..." },
  "hash": "sha256..."
}
```

The server recomputes the hash and stores the package under
`data/packages/<id>/<version>.json`.

`x-agentbox-user` is optional; it is used for audit and self-review checks.
Reviewers cannot approve their own upload unless they are admins.

## Storage

```text
data/
  index.json
  policies.json
  audit.jsonl
  packages/<id>/<version>.json
```

This MVP uses the filesystem and a single process. Put it behind TLS and a
reverse proxy in production, back up `data/`, and replace the token map with
OIDC/SSO later.

## Tests

```powershell
npm test
```
