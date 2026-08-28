# Profile 与 URL Rules 需求、实现记录与边界

## 1. 文档目的

本文档是当前项目 Profile/Rule 自动路由的权威说明，记录已确认需求、当前实现、边界行为以及明确不考虑的范围。历史 roadmap、backlog 或上游 SessionShift 文档中若存在不同的 Rule schema 或状态描述，以本文档和当前代码为准。

目标是：

```text
当前 Tab 的 URL
    ↓
匹配 Rules
    ↓
得到 profileId
    ↓
绑定 Tab → Profile
    ↓
沿用现有 Cookie、localStorage、sessionStorage、IndexedDB、Cache 和 DNR 隔离能力
```

本功能只负责“根据 URL 选择哪个 Profile”。实际的 Cookie 和页面存储隔离继续由 SessionShift 现有的 Tab→Profile、DNR 和页面 API 代理机制完成。

## 1.1 Profile/Rule 配置导入导出

Options 页提供一个版本化 JSON 文件的全量导入/导出入口，文件结构为：

```json
{
  "version": 1,
  "profiles": [],
  "rules": []
}
```

- 导出始终写出全部 Profile 元数据和全部 Rules，不按当前页面或当前 Tab 筛选；
- 导入必须先完成 JSON、字段、ID 唯一性和 Rule 匹配条件校验，校验失败时不修改现有数据；
- 用户确认后，导入一次性覆盖 `profiles` 和 `routingRules` 两个配置集合；
- Rule 引用不存在的 `profileId` 仍然保留为 orphan rule，以便后续修复，但不会参与匹配；
- Cookie、localStorage、sessionStorage、IndexedDB、Cache 等实际会话数据不进入该文件，也不会因配置导入而被导出；
- 导入文件的 `version` 当前必须为 `1`，未来格式变化应通过版本号显式区分。

## 2. 已确认的产品决策

### 2.1 Profile 与 Rule 在 UI 上分离

配置界面增加两个独立的 Tab：

- **Profiles**：创建、切换、重命名、改颜色、复制和删除 Profile；
- **Rules**：创建、查看、编辑、启用/禁用和删除 URL Rule。

当前 Popup 中已有的 Profile 列表和点击切换行为必须保留。用户点击一个 Profile 时，仍然立即把当前 Tab 切换到该 Profile 并刷新页面。

Rules 不嵌套存储在 Profile 对象内部，而是独立存储，通过 `profileId` 引用 Profile。UI 可以在 Profile 页面显示“被多少条 Rule 引用”，也可以在 Rule 页面显示目标 Profile。

### 2.2 Rule 必须明确指向一个 Profile

创建 Rule 时，`profileId` 是必填字段。UI 使用下拉框选择 Profile，展示 Profile 名称、颜色和必要时的 ID 摘要。

如果没有任何 Profile，应禁用 Rule 创建，并提供“先创建 Profile”的引导。

### 2.3 Rule 的必填与可选字段

本设计按以下解释执行：

- 必填：`name`、`profileId`、`match.scheme`、`match.hostname`；
- 可选：`match.port`、`match.urlRegex`；
- 自动生成：`id`；
- UI 默认值：`enabled = true`、`priority = 100`。

因此，当前版本不支持没有任何匹配条件的全局 catch-all Rule。未来如果确实需要“匹配所有 URL”，应增加显式的 `matchAll` 类型，而不是用空 `match` 静默表达，避免误配置导致所有网站被切换到某个 Profile。

## 3. Rule 数据结构

### 3.1 Profile

现有 Profile 结构继续使用，Profile ID 必须稳定，不能使用可修改的 name 作为引用：

```ts
type Profile = {
  id: string
  name: string
  hue?: number
}
```

现有存储方式保持不变：

```text
chrome.storage.local.profiles
chrome.storage.local.cookies_<profileId>
```

### 3.2 Rule

建议使用以下结构：

```ts
type ProfileRule = {
  id: string
  name: string
  profileId: string
  enabled: boolean
  priority: number
  match: {
    scheme: 'http' | 'https'
    hostname: string
    port?: number
    urlRegex?: string
  }
}
```

示例：

```json
{
  "id": "rule_8f5d...",
  "name": "GDC 开发环境",
  "profileId": "session_dev_gdc",
  "enabled": true,
  "priority": 100,
  "match": {
    "scheme": "https",
    "hostname": "dev.example.com",
    "port": 8443,
    "urlRegex": "^https://dev\\.example\\.com(?::8443)?/"
  }
}
```

规则列表建议存储在独立的 `chrome.storage.local.routingRules` 中：

```text
profiles       → Profile 配置
routingRules   → URL 到 Profile 的路由规则
cookies_<id>   → 每个 Profile 的 Cookie 数据
```

### 3.3 字段语义

#### `id`

- 创建时自动生成，例如 `rule_<crypto.randomUUID()>`；
- 用户不填写，也不允许通过 UI 修改；
- 用于日志、冲突提示、调试以及 Profile 名称变化后的稳定引用。

#### `name`

- 面向用户的 Rule 名称，建议必填；
- 用于当前 Tab 状态展示，例如“来源：GDC 开发环境”；
- 如果未来允许空名称，至少要使用 Rule ID 作为稳定后备显示值。

#### `profileId`

- 必填；
- 创建和更新时必须校验引用的 Profile 仍然存在；
- 删除 Profile 时不能删除引用它的 Rules；这些 Rules 必须保留，并在 UI 中标记为 `Deleted profile`/`已删除 Profile`；
- 引用不存在 Profile 的 Rule 永远不能参与匹配，也不能重新绑定任何 Tab；只有用户把它重新指向一个现存 Profile 后才可以恢复生效。

#### `enabled`

- 创建时默认 `true`；
- UI 使用开关控制；
- 禁用的 Rule 不参与匹配，但数据仍保留。

#### `priority`

- 创建时默认 `100`，不要求用户填写；
- 可以放在“高级设置”中修改；
- 数值越大优先级越高；
- 多条规则同时命中时，必须使用稳定、可解释的排序规则。

#### `match.scheme`

- 必填，只允许 `http` 或 `https`；
- 不包含 `://`；
- 不允许用正则绕过协议字段的校验。

#### `match.hostname`

- 必填；
- 保存时统一转为小写并去除末尾的点；
- 不包含协议、路径和端口；
- 可以是域名或 IP；
- MVP 先按精确 hostname 匹配，通配域名和更复杂的域名语义另行设计。

#### `match.port`

- 可选；
- 取值范围 `1–65535`；
- 省略时表示任意端口；
- `http` 和 `https` 的默认端口应在规范化时正确处理：URL 未显式写端口时，不能简单当成任意自定义端口。

#### `match.urlRegex`

- 可选；
- 匹配规范化后的完整 HTTP/HTTPS URL；
- 与 `scheme`、`hostname`、`port` 是 AND 关系：所有已填写条件都满足才算命中；
- 保存时立即编译并校验正则，非法正则不能保存；
- UI 显示示例和测试 URL，避免用户误以为它只匹配 hostname；
- 正则长度应设置上限，避免每次导航执行过大的表达式。

## 4. Rule 匹配和绑定行为

### 4.1 匹配流程

新增纯函数模块，例如 `src/background/rule-resolver.ts`，负责：

1. 解析和规范化 URL；
2. 过滤 `enabled === false` 的 Rule；
3. 校验 Profile 是否存在；
4. 判断 scheme、hostname、port 和 urlRegex；
5. 对命中的 Rules 排序；
6. 返回最终的 `profileId`、`ruleId` 和 Rule 名称。

建议的冲突选择顺序：

```text
priority 数值降序
    ↓
匹配条件更具体的 Rule 优先
    ↓
Rule 创建时间或稳定数组顺序
```

最终结果必须稳定，不能因为对象遍历顺序或 Service Worker 重启而改变。

### 4.2 Tab 绑定来源

当前项目的 `tabSessions` 仍然保持 `tabId → profileId` 的简单结构，避免破坏现有存储和恢复逻辑。

另增加一个 Tab 元数据映射，例如：

```ts
type TabBindingMeta = {
  source: 'manual' | 'rule' | 'inherit' | 'default'
  ruleId?: string
}
```

持久化为：

```text
chrome.storage.session.tabSessions
chrome.storage.session.tabBindingMeta
```

这样既保留现有兼容性，又能在 UI 上说明当前 Profile 是如何得到的。

建议优先级：

```text
用户手动选择 Profile
    > URL Rule
    > 链接 Tab 继承
    > default
```

手动点击 Profile 后，当前 Tab 进入 `manual` 状态，后续导航不应立即被 Rule 覆盖。用户点击“恢复自动匹配”后，才清除手动覆盖并重新按 URL 计算。

### 4.3 没有命中 Rule 时

自动模式下，如果顶层页面 URL 没有命中任何 Rule，建议绑定到 `default`，而不是继续沿用上一个 Rule Profile。链接 Tab 的既有 `inherit` 绑定是兼容现有功能的例外：在没有 Rule 命中时继续继承 opener Profile，直到用户手动切换或命中新的 Rule。

手动绑定的 Tab 不受这个行为影响，直到用户恢复自动匹配。

### 4.4 只匹配顶层导航

Rule 只用于顶层页面导航：

- 不因为 iframe、图片、脚本或 XHR URL 命中 Rule 而切换整个 Tab；
- 普通页面导航时重新计算绑定；
- SPA 的 `history.pushState` 是否触发重新匹配，第一阶段不处理；
- 如果未来支持 SPA 路由切换，需要单独设计“切换 Profile 是否刷新页面”和数据迁移边界。

### 4.5 同一个 URL 的多 Tab 并行

URL Rule 本身是确定性的：同一个 URL 默认会得到同一个 Profile。

如果两个 Tab 访问完全相同的 URL，但需要使用不同 Profile，必须使用 Tab 级手动绑定：

```text
Tab A → 手动绑定 → Staging
Tab B → 手动绑定 → Production
```

这部分是多 Tab 并行隔离的必要条件，不能只依赖 URL Rule。

### 4.6 默认页与导航时序边界

为了避免页面伪造 `postMessage`，MAIN-world API proxy 只接受 ISOLATED-world content script 发出的 Profile 身份信号。默认页在异步查询期间保持浏览器原生 Cookie、Storage、IndexedDB、Cookie Store、Fetch 和 XHR API；background 只在确认当前文档属于 Profile 后，才通过受权限保护的 `chrome.scripting.executeScript`（针对当前 `documentId`）恢复/清理必要的 MAIN-world 状态，随后安装 Profile 代理。页面脚本不能直接触发这个 privileged transition，也不能用旧 document 的消息影响新 document。默认页不会收到任何 Profile Cookie 或 Profile ID。

导航前置保护使用精确目标 URL 的一次性 Cookie strip；普通 DNR base rule 也覆盖 `main_frame`，避免异步前置保护未及时发布时泄漏共享 Cookie。响应侧 `Set-Cookie` 剥离覆盖全部资源类型，包括 `main_frame`/`sub_frame`，并由 `webRequest` 捕获后写入 Profile。对于带重定向的导航，扩展先在内存中乐观发布刚捕获的 Profile Cookie，再持久化，避免重定向请求错过新 Cookie。认证 fetch/XHR 会等待 Profile DNR 发布完成；页面写 Cookie 后紧跟的 fetch/XHR 也会等待后台确认（带超时 fail-open）。

页面 Cookie 视图不再使用单一的 `name → value` Map；bootstrap 会携带 `name/value/path` 条目，并按请求路径筛选、按 Path 长度排序，因此同名不同 Path 的 Cookie 不会互相覆盖。

Service Worker 冷启动且 `routingRules` 尚未读入内存时，不会对“可能仍属于同一 Profile”的 reload 盲目安装一次性 Cookie strip，以免正常页面首个请求丢失 Profile Cookie；待规则快照可用后，仅在已知 Profile 上下文确实变化时做精确目标 URL 的一次性 strip。由此冷启动首次发生跨 Profile 自动切换时仍是最佳努力边界，后续请求会由确定的 Profile DNR 规则保护。

## 5. Popup UI 设计

图片中的现有 Popup 结构作为设计基线。

### 5.1 当前 Tab 状态区域

顶部“此标签页已激活”区域保留，并补充绑定来源：

#### 无规则、默认状态

```text
Default
未启用 Profile
```

这里仍然显示 `default`，不改变原来的默认状态和 Profile 点击切换行为。

#### Rule 命中状态

```text
dev-gdc
实时
Rule：GDC 开发环境（rule_xxx）
```

必须清楚显示命中的 Rule 名称；Rule 名称缺失或过长时显示 Rule ID 作为后备。

#### 手动绑定状态

```text
dev-gdc
手动绑定
恢复自动匹配
```

#### 链接继承状态

```text
dev-gdc
从来源 Tab 继承
```

### 5.2 Profile/Rules 两个视图

在当前“配置文件”列表区域增加两个 UI Tab：

```text
配置文件 | Rules
```

#### 配置文件视图

保持现有行为：

- 搜索 Profile；
- 创建 Profile；
- 点击 Profile 切换当前 Tab；
- 重命名、改颜色、复制、删除；
- 右键 Profile，在新 Tab 中打开当前页面；
- 当前激活 Profile 继续使用选中态展示。

#### Rules 视图

显示：

- Rule 名称；
- 绑定的 Profile 名称和颜色；
- 匹配摘要，例如 `https://dev.example.com:8443`；
- enabled 状态；
- priority；
- 命中冲突或失效引用提示。

提供：

- 创建 Rule；
- 编辑 Rule；
- 复制 Rule；
- 启用/禁用；
- 删除 Rule；
- 使用当前页面填充匹配条件；
- 测试当前页面 URL。

### 5.3 Rule 创建表单

表单建议顺序：

1. Rule name，必填；
2. Profile，下拉选择，必填；
3. Scheme，必填；
4. Hostname，必填；
5. Port，可选；
6. URL Regex，高级可选项；
7. Enabled，默认开启；
8. Priority，默认 100，可放入高级设置。

保存前显示预览：

```text
当 URL 满足：
https://dev.example.com:8443 + 可选正则

绑定到：
dev-gdc
```

建议增加“测试 URL”输入框，实时显示：

```text
命中：GDC 开发环境
规则：GDC 开发环境（rule_xxx）
```

如果多个 Rule 命中，显示所有命中项以及最终采用哪一条和原因。

## 6. 当前实现落点

### 6.1 数据和类型

已实现：

- `src/lib/types.ts`
  - 增加 `ProfileRule`、`RuleMatch`、`TabBindingMeta`；
  - 扩展后台消息类型；
- `src/lib/session-store.ts`
  - 保留现有 Profile 和 Cookie Store；
- `src/lib/rule-store.ts`
  - 集中访问 `chrome.storage.local.routingRules`；
  - 统一校验和规范化；
  - 保留 orphaned Rule，不因 Profile 删除而级联删除；
  - 提供 Rule 的 Profile 状态查询，供 UI 显示 `Deleted profile`。

### 6.2 Rule 匹配和后台绑定

已实现：

- `src/background/rule-resolver.ts`
  - URL 规范化；
  - scheme/hostname/port/regex 匹配；
  - priority 和 specificity 排序；
  - 返回命中 Rule 元数据。
- `src/background/rule-manager.ts`
  - 注册顶层导航监听；
  - 根据 URL 解析 Profile；
  - 更新 `tabSessions` 和 `tabBindingMeta`；
  - 调用现有 `updateDNRRulesForTab()`；
  - 通知页面刷新 Profile bootstrap。

- `src/background/index.ts`
  - 注册 Rule 导航监听；
- `src/background/session-manager.ts`
  - 恢复和保存 Tab 来源元数据；
- `src/background/message-handler.ts`
  - 保持现有 `setSession` 兼容；
  - 手动切换时记录 `source: manual`；
  - 增加恢复自动匹配的消息；
- `src/background/linked-tab-inheritance.ts`
  - 按“手动 > Rule > 继承”处理链接新 Tab；
- `src/background/context-menu-manager.ts`
  - Profile 相关菜单继续保留；
  - Rule 不直接替代现有“Open in Session”菜单。

现有 `src/background/dnr-manager.ts` 和 `src/background/dnr-cookie-rule-builder.ts` 的核心隔离逻辑不应重写。它们继续读取最终的 `tabSessions[tabId]`，Rule 只负责在此之前决定 Profile。

### 6.3 Popup 和 Options UI

已实现：

- `src/popup/popup.html`
  - 增加 Profiles/Rules 视图 Tab；
  - 增加当前绑定来源和 Rule 信息区域；
- `src/popup/popup.ts`
  - 保留当前 Profile 点击切换行为；
  - 管理 Profiles/Rules 视图切换；
  - 读取当前 Tab 的 binding metadata；
- `src/popup/popup-render-profile-list.ts`
  - 保持现有 Profile 卡片功能；
- `src/popup/popup-rule-view.ts`
  - Rule 列表、表单、校验、冲突提示和测试 URL；
- `src/popup/popup.css`
  - 复用现有 Stacks 视觉系统、颜色和可访问性样式；
  - 确保 Rule 表单在 Popup 高度受限时可滚动。

Options 页面当前只有 Settings/About。第一阶段可以保留它们不变；如果 Rule 表单在 Popup 中过长，再把相同的 Rules 管理能力复用到 Options 页面，而不是改变数据模型。

### 6.4 国际化

新增 UI 文案必须接入现有本地化系统，包括：

- Profiles/Rules Tab 名称；
- Rule 创建和校验错误；
- Profile 下拉框；
- 命中来源、手动绑定、恢复自动匹配；
- 冲突和失效引用提示；
- 删除确认和全局规则警告（如未来支持）。

需要同步维护 `src/_locales/*/messages.json` 的 key/placeholder 一致性，不能只在英文目录增加 key。

## 7. 实现阶段

### Phase 1：数据模型与纯逻辑

- 定义 Rule 类型和存储 schema；
- 实现 CRUD、Profile 引用校验和规范化；
- 实现 URL matcher、正则校验和冲突排序；
- 添加单元测试；
- 不改变现有 Profile 手动切换流程。

### Phase 2：后台自动路由

- 注册顶层导航规则解析；
- 增加 `tabBindingMeta`；
- 接入现有 `setSession`/DNR/bootstrap 链路；
- 处理手动覆盖、恢复自动匹配、无规则命中；
- 覆盖 Service Worker 重启和 Tab 关闭清理。

### Phase 3：Popup UI

- 增加 Profiles/Rules 视图；
- 实现 Rule 列表和表单；
- 增加 Profile 下拉选择；
- 显示当前命中的 Rule name/ID；
- 增加测试 URL、冲突和校验提示；
- 保证原有 Profile 点击切换不变。

### Phase 4：多 Tab 与回归验证

- 验证同一 URL 下手动绑定不同 Profile 的并行隔离；
- 验证 Rule 命中后的 Cookie、Storage 和页面 bootstrap；
- 验证链接继承与 URL Rule 的优先级；
- 验证首个请求时序和现有已知限制；
- 运行现有 Unit/E2E 测试并补充 Rule 测试。

## 8. 测试要求

### 单元测试

至少覆盖：

- scheme 精确匹配；
- hostname 大小写和末尾点规范化；
- port 缺省、显式端口和非法端口；
- 正则有效、无效和 AND 组合；
- disabled Rule 不命中；
- 不存在的 profileId 不能保存或不能参与匹配；
- priority 冲突；
- 多条规则同优先级时结果稳定；
- 无 Rule 命中时回到 default；
- 手动绑定覆盖 Rule；
- 恢复自动匹配后重新解析；
- Profile 删除后 Rule 保留、显示 Deleted profile 且不再命中；
- 将 orphaned Rule 重新指向现存 Profile 后可以恢复命中。

### E2E 测试

建议新增：

- Rule 创建、编辑、复制、删除；
- Rule 启用/禁用；
- Rule Profile 下拉选择；
- URL 命中后 Profile 和 Rule 来源展示；
- 不同 URL 自动绑定不同 Profile；
- 同一个 URL 的两个 Tab 手动绑定不同 Profile；
- Cookie 和 localStorage 的并行隔离；
- Rule 冲突提示和 priority 选择；
- 链接继承与 Rule 优先级；
- Service Worker 重启后的 Rule 和 Tab 绑定恢复。

## 9. Corner cases 与确定行为

| 场景 | 当前确定行为 |
|---|---|
| Profile 被删除，但 Rule 仍引用其 ID | Rule 独立保留，不级联删除；UI 显示 `Deleted profile`；解析器永远跳过它。用户必须编辑 Rule 并选择一个当前存在的 Profile，Rule 才能恢复生效。旧 Profile ID 不会因为同名 Profile 被重新创建而复活。 |
| 创建或更新 Rule 时引用不存在的 Profile | 拒绝保存。孤儿 Rule 只可能来自其 Profile 在保存后被删除；编辑孤儿 Rule 时必须选择替代 Profile。 |
| 孤儿 Rule 仍为 enabled | 可以保留 enabled 状态，但 enabled 不会绕过 Profile 存在性检查，因此它仍不命中、不绑定 Tab。 |
| 多条 Rule 同时命中 | 先按 priority 数值降序；相同 priority 下，带 URL regex 的优先于不带 regex，带 port 的优先于不带 port；仍相同时按持久化数组顺序稳定选择。 |
| port 未填写 | 表示任意有效端口；URL 没写端口时按协议有效端口计算（HTTP 为 80，HTTPS 为 443），因此填写 `80`/`443` 可以匹配省略默认端口的 URL。 |
| URL regex 未填写、为空或非法 | 未填写表示不增加完整 URL 条件；UI 的空输入不保存该字段；非法表达式或超过 500 字符时拒绝保存。regex 与 scheme、hostname、可选 port 是 AND 关系。URL fragment 在匹配前移除。 |
| hostname 大小写、末尾点、IP | 保存和匹配时转小写并移除末尾点；支持合法域名、IPv4 和带方括号的 IPv6；不支持通配 hostname。 |
| 非 HTTP(S)、无效 URL、iframe 或子资源 | 不触发 Rule；恢复自动匹配时回到 default。Rule 只处理顶层 HTTP(S) 导航。当前版本不监听 SPA `pushState`。 |
| 在 `chrome://`、扩展页或其他不可隔离页面打开 Popup | Profile/Rule 仍可作为全局配置创建和管理；当前 Tab 不会绑定 Profile，Profile 卡片的切换动作保持不可用，并显示“此页面无法隔离”。 |
| 当前 URL 没有 Rule 命中 | 自动模式回到 default；既有的 linked-tab inherit 是兼容例外，在无命中时继续继承。手动绑定不受影响。 |
| 用户手动选择 Profile | 当前 Tab 进入 manual 状态，后续 Rule 不覆盖它；点击“恢复自动匹配”后，才按当前 URL 重新解析。 |
| 相同 URL 的多个 Tab 需要不同 Profile | 自动匹配会得到同一个赢家；分别手动绑定各 Tab 后可并行使用不同 Profile，Cookie 和页面 Storage 仍按 Tab→Profile 隔离。 |
| 快速连续导航或解析期间手动切换 | 每个 Tab 使用导航 generation 和串行绑定队列；过期异步结果不会覆盖更新的导航或手动选择。 |
| Tab 关闭、Service Worker 重启 | Tab 关闭时清理绑定元数据和对应 DNR；Rule 与 Profile 数据持久化保留。Service Worker 恢复后重建内存快照和有效 Tab 绑定。 |
| Rule 被禁用或删除 | 禁用只停止匹配并保留配置；删除只删除该 Rule。已经打开的 Tab 会在下一次自动解析时根据剩余 Rule/default 更新，不删除目标 Profile。 |
| Profile 名称或颜色变化 | Rule 仍通过稳定的 profileId 绑定，不受名称和颜色变化影响；UI 读取 Profile 的最新显示信息。 |

## 10. 明确不考虑的内容

第一阶段不考虑：

- 创建真正的 Chrome 用户 Profile 或操作系统级容器；
- 使用 URL Rule 让同一个 Tab 同时拥有多个 Profile；
- 让 iframe、XHR 或图片请求单独切换 Profile；
- SPA `pushState` 后立即自动切换 Profile；
- 云端同步 Profile、Rule、Cookie 或 Storage；
- 将现有 Chrome 全局 Cookie 迁移到 Profile；
- 自动登录、自动填写账号密码；
- 用 Rule 替换现有右键“Open in Session”手动打开功能；
- 当前版本的空 `match` 全局规则；
- 删除 Profile 时级联删除引用它的 Rule；
- 通过任意正则实现复杂的通配域名语义；
- 修改现有 DNR Cookie 隔离算法来承载 Rule 解析；
- 尽可能解决普通自动导航或链接新 Tab 场景下的首个请求时序问题；已知 Profile
  上下文变化时会做精确目标 URL 的 Cookie strip，保持同一 Profile 的 reload/
  跳转不被误伤。由于 Chrome 在页面触发的新 Tab 中可能先于扩展事件发出首个请求，
  仍保留“最佳努力、后续请求确定隔离”的边界说明。
- 让一个 URL Rule 同时为同一 Tab 激活多个 Profile；Profile 仍然是一个 Tab 的单一绑定。

## 11. 验收标准

功能完成后应满足：

1. 用户可以分别管理 Profiles 和 Rules；
2. Rule 创建时必须选择一个有效 Profile；
3. scheme 和 hostname 必须填写，port 和 URL regex 可以不填；
4. 新 Rule 默认启用且 priority 为 100；
5. Rule 命中后，当前 Tab 自动绑定目标 Profile；
6. Popup 顶部显示当前 Profile 以及命中的 Rule name/ID；
7. 用户手动点击 Profile 的行为与当前版本一致；
8. 手动绑定可以覆盖 Rule，并可恢复自动匹配；
9. 同一个 URL 的不同 Tab 可以通过手动绑定使用不同 Profile；
10. 现有 Cookie、页面 Storage、DNR、链接继承和 Profile CRUD 测试不回归。
