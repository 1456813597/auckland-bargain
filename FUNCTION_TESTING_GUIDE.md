# Auckland Bargain 全面功能测试指南

本文档用于测试本项目的本地开发实例、本地生产模式和远程生产实例。命令以 PowerShell 为主，适用于当前项目环境。

> [!IMPORTANT]
> `/api/cron/woolworths` 和 `/api/cron/paknsave` 会请求真实零售商接口并写入 Supabase。除非已经获得生产环境操作权限并明确准备进行一次真实采集，否则只测试它们的 `401` 未授权行为，不要携带正确的 `CRON_SECRET` 调用。

## 1. 先理解系统和测试边界

完整数据流是：

```text
浏览器首页
  -> GET /api/deals
  -> Supabase current_deals + offer_history
  -> 商品卡片、搜索/筛选/排序、90 天历史弹窗

Vercel Cron 或管理员手动触发
  -> GET /api/cron/woolworths 或 /api/cron/paknsave
  -> 零售商公开接口
  -> Supabase retailers/stores/products/current_offers/offer_history
  -> GET /api/deals
  -> 浏览器显示最新数据
```

项目现有接口：

| 路径 | 功能 | 正常结果 | 是否写数据 |
| --- | --- | --- | --- |
| `/` | 商品优惠仪表盘 | `200`，页面可交互 | 否 |
| `/api/deals` | 当前优惠列表及查询 | `200` JSON | 否 |
| `/api/products/:id` | 单个商品详情 | 存在时 `200`，不存在时 `404` | 否 |
| `/api/health/ready` | 应用与数据库就绪检查 | 就绪时 `200`，否则 `503` | 否 |
| `/api/cron/woolworths` | Woolworths 采集 | 未授权 `401`；成功 `200` | **是** |
| `/api/cron/paknsave` | PAK'nSAVE 采集 | 未授权 `401`；成功 `200` | **是** |

本项目现有自动化测试覆盖零售商数据映射、分页/重试/门店一致性、PAK'nSAVE 匿名鉴权及 Cron Bearer Token 校验，但尚未包含浏览器 E2E、真实 Supabase 集成测试或真实零售商接口测试。因此“`npm test` 通过”不等于整个系统已通过。

## 2. 测试环境与通过标准

建议依次测试三个环境，后一个环境不要替代前一个：

1. **本地 Demo 模式**：不连接 Supabase，快速验证前端和只读 API 的降级行为。
2. **本地生产模式 + 测试 Supabase**：使用构建产物和独立测试数据库验证真实数据流。
3. **远程生产实例**：先做只读冒烟测试，再在获得授权后测试真实采集。

总通过标准：

- 测试、类型检查、Lint 和生产构建全部退出码为 `0`。
- 首页在桌面和手机宽度下可用，浏览器控制台无未处理错误。
- 所有只读接口的状态码、响应结构、过滤结果及缓存头符合本文预期。
- 连接数据库时 `/api/health/ready` 返回 `200`、`ready: true` 和预期 schema version。
- 生产环境 `/api/deals` 必须为 `meta.demo: false`，且数据新鲜度符合业务要求。
- 未携带或携带错误 Cron Token 时始终返回 `401`。
- 获授权执行真实采集后，采集运行成功、数据写入正确、前台能读取新数据，并且没有泄露密钥。

## 3. 准备工作

要求 Node.js `22.13.0` 或更高版本。先检查工具：

```powershell
node --version
npm --version
```

全新检出建议使用锁文件安装：

```powershell
npm ci
```

本地环境文件是 `.env.local`，它已被 `.gitignore` 排除。不要覆盖已有文件，也不要在日志、截图或测试报告中粘贴变量值。项目可能使用以下变量：

| 变量 | 用途 | 要求 |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase 项目 URL | 集成/生产必需 |
| `SUPABASE_SECRET_KEY` | 服务端 Supabase 密钥 | 集成/生产必需，绝不能加 `NEXT_PUBLIC_` |
| `SUPABASE_SERVICE_ROLE_KEY` | 旧版密钥名 | 仅作为上一个变量的兼容替代 |
| `CRON_SECRET` | Cron Bearer Token | 至少 16 个字符 |
| `BLOB_READ_WRITE_TOKEN` | 将商品图片复制到 Vercel Blob | 真实采集建议配置 |
| `WOOLWORTHS_COOKIE` | 可选的选店会话 Cookie | 仅服务端，禁止提交或打印 |
| `PAKNSAVE_STORE_ID` | 精确的 PAK'nSAVE 门店 UUID | 可选；默认 Royal Oak |
| `SITE_URL` | Metadata 的站点基址 | 生产环境应为正式 HTTPS URL |

仅确认变量“是否存在”，不要输出变量值：

```powershell
Get-Content .env.local |
  Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' } |
  ForEach-Object { ($_ -split '=', 2)[0].Trim() }
```

//## 4. 第一阶段：静态检查和现有自动化测试

从仓库根目录依次运行：

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

每条命令都应以退出码 `0` 结束。不要因为最后的 `build` 成功就忽略前面命令的失败。

当前 `npm test` 应验证：

- Cron 在没有密钥时失败关闭，且只接受完全匹配的 Bearer Token。
- Woolworths 价格转为整数 NZ cents，会员价与普通促销价分开。
- Woolworths 正确分页、去重、重试临时错误，并在中途门店变化时终止。
- PAK'nSAVE 处理匿名登录、Royal Oak 门店解析、分页、多件促销单价和会员价。
- PAK'nSAVE 超过 `PAKNSAVE_MAX_PAGES` 时不提交不完整快照。

如果有失败，先保留完整错误输出，再按“测试代码 -> 类型/Lint -> 构建”的顺序定位。不要跳过失败项继续发布。

## 5. 第二阶段：本地 Demo 模式

### 5.1 启动开发实例

Demo 模式要求 Next.js 进程中没有同时配置 `SUPABASE_URL` 与 Supabase 服务端密钥。当前实例若只有其他变量，也会自动使用内置 Demo 数据。

终端 A：

```powershell
npm run dev
```

终端 B：

```powershell
$BaseUrl = 'http://localhost:3000'
curl.exe -sS -i "$BaseUrl/api/deals"
```

若 `3000` 已占用，Next.js 可能选择另一个端口；以终端 A 输出为准并修改 `$BaseUrl`。

### 5.2 Demo API 冒烟测试

读取并检查基础响应：

```powershell
$payload = Invoke-RestMethod "$BaseUrl/api/deals"
$payload.meta
$payload.data.Count
$payload.data[0]
```

预期：

- HTTP `200`。
- `meta.demo` 为 `true`。
- `meta.currency` 为 `NZD`，`meta.timezone` 为 `Pacific/Auckland`。
- `data` 是非空数组；当前内置数据通常为 8 条，但测试不应永久写死这个数量。
- 响应头包含 `Cache-Control: no-store, max-age=0`。

测试查询参数：

```powershell
Invoke-RestMethod "$BaseUrl/api/deals?q=butter"
Invoke-RestMethod "$BaseUrl/api/deals?category=dairy"
Invoke-RestMethod "$BaseUrl/api/deals?retailer=woolworths"
Invoke-RestMethod "$BaseUrl/api/deals?minDiscount=10"
Invoke-RestMethod "$BaseUrl/api/deals?q=anchor&category=dairy&minDiscount=5"
```

逐项确认返回的每条记录都满足对应条件；大小写不应影响 `q`、`category` 或 `retailer` 匹配。

测试商品详情：

```powershell
$deals = Invoke-RestMethod "$BaseUrl/api/deals"
$id = [uri]::EscapeDataString($deals.data[0].id)
Invoke-RestMethod "$BaseUrl/api/products/$id"
curl.exe -sS -i "$BaseUrl/api/products/does-not-exist"
```

预期：已存在商品返回 `200` 且 `data.id` 匹配；不存在商品返回 `404` 和 `{"error":"Product not found"}`。

Demo 模式没有数据库，所以就绪检查返回 `503` 是正确行为：

```powershell
curl.exe -sS -i "$BaseUrl/api/health/ready"
```

响应体应为 `ready: false`，并显示 `checks.supabaseConfigured: false`。这不是 Demo 模式的故障。

确认 Cron 安全边界，以下请求不会写数据：

```powershell
curl.exe -sS -i "$BaseUrl/api/cron/woolworths"
curl.exe -sS -i -H "Authorization: Bearer definitely-wrong" "$BaseUrl/api/cron/paknsave"
```

两者都必须返回 `401`。如果缺少正确 Token 时仍能开始采集，立即停止测试并作为发布阻断问题处理。

### 5.3 本地 UI 功能清单

打开 `http://localhost:3000`，同时打开浏览器开发者工具的 Console 和 Network。按下表逐项测试：

| 编号 | 操作 | 预期结果 |
| --- | --- | --- |
| UI-01 | 首次打开首页 | 标题、统计区和商品卡片显示；Network 中 `/api/deals` 为 `200` |
| UI-02 | 查看页脚 | Demo 模式显示 `Preview mode` 提示 |
| UI-03 | 搜索 `butter` | 只保留名称、品牌、门店或分类匹配项，匹配数量同步变化 |
| UI-04 | 点击清除搜索按钮 | 搜索框清空，全部符合其他筛选条件的结果恢复 |
| UI-05 | 切换分类按钮 | 只显示该分类；选中态清晰 |
| UI-06 | 切换 retailer 下拉框 | 只显示选择的零售商 |
| UI-07 | 关闭 `Member prices` | 所有 `memberOnly: true` 商品消失；重新开启后恢复 |
| UI-08 | 选择 `Best score` | 分数从高到低排列 |
| UI-09 | 选择 `Biggest saving` | 相对 90 天均价的折扣百分比从高到低排列 |
| UI-10 | 选择 `Lowest price` | 商品价格从低到高排列 |
| UI-11 | 组合搜索和筛选得到零结果 | 显示 `No matching deals` 空状态 |
| UI-12 | 点击 `Reset all filters` | 搜索、分类、零售商和会员价选项恢复默认值 |
| UI-13 | 点击商品卡片箭头 | 弹出 90 天价格历史，今日价、均价、最低价和图表可见 |
| UI-14 | 用 Close、右上角、Esc 和点击遮罩关闭弹窗 | 弹窗关闭，焦点返回合理位置 |
| UI-15 | 点击 `Refresh data` | 按钮短暂进入 Refreshing 状态，只发起一次 `/api/deals` 请求 |
| UI-16 | 断网后点击刷新 | 页面不崩溃；Console 有明确错误；屏幕阅读器状态区收到失败消息 |
| UI-17 | 商品图片加载失败 | 页面布局不应整体崩坏，其他商品仍可操作 |

再执行以下兼容性与可访问性检查：

- 在 `375 x 812`、`768 x 1024`、`1440 x 900` 三种视口下检查无水平溢出、遮挡或不可点击控件。
- 只用键盘完成搜索、筛选、排序、打开/关闭详情；焦点指示必须可见。
- 浏览器缩放至 `200%`，正文和按钮不得重叠或被裁切。
- 检查 Console 没有 React hydration、图片域名、未处理 Promise 或图表尺寸错误。
- 检查 Network 没有意外 `4xx/5xx`；商品图片的个别上游失败应与应用接口失败区分记录。

## 6. 第三阶段：本地生产模式 + 测试 Supabase

此阶段必须使用独立的测试 Supabase 项目，不能把开发采集直接指向生产数据库。

### 6.1 准备测试数据库

安装并登录 Supabase CLI 后：

```powershell
supabase link --project-ref YOUR_TEST_PROJECT_REF
supabase migration list
supabase db push
supabase db push --dry-run
```

预期最后一条命令没有待应用迁移。不要通过 HTTP 路由或 SQL Editor 手工执行迁移文件；迁移必须以 `supabase/migrations` 为准。

在 `.env.local` 中配置测试项目的 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、至少 16 字符的 `CRON_SECRET`，以及可选的 Blob/门店变量。然后运行：

```powershell
npm run release:ready
```

预期退出码为 `0`，JSON 中：

- `ready: true`
- `checks.cronSecretConfigured: true`
- 数据库的所有 readiness checks 均为 `true`
- `schemaVersion` 为 `20260831160000`

### 6.2 用真实构建产物启动

Next.js 官方建议 E2E 测试尽量针对生产构建：

```powershell
npm run build
npm run start
```

另开终端，将 `$BaseUrl` 设为实际地址，重复第 5.2 和 5.3 节。此时差异应为：

- `/api/health/ready` 返回 `200` 和 `ready: true`。
- `/api/deals` 的 `meta.demo` 为 `false`。
- 页脚显示 Live 数据提示。
- `updatedAt` 是可解析的 ISO 时间，首页按 `Pacific/Auckland` 显示更新时间。

### 6.3 授权后的本地真实采集

这是写操作。先确认 `.env.local` 指向测试数据库，并确认没有另一轮采集正在执行。为避免把密钥写进命令历史，可交互式读取：

```powershell
$CronSecret = Read-Host 'CRON_SECRET' -MaskInput
curl.exe -sS -i --max-time 310 -H "Authorization: Bearer $CronSecret" "$BaseUrl/api/cron/woolworths"
curl.exe -sS -i --max-time 310 -H "Authorization: Bearer $CronSecret" "$BaseUrl/api/cron/paknsave"
Remove-Variable CronSecret
```

一次只调用一个采集器。预期成功响应为 `200`、`ok: true`，并包含门店、页数、上游报告数量、持久化统计和采集时间。其他重要状态：

- `401`：Token 缺失或错误。
- `409`：同一零售商/门店已有采集在运行；不要并发重试。
- `500`：采集失败；使用返回的 `runId` 对照服务端日志和 `collection_runs`。
- `503`：服务端 Supabase 未配置。

采集完成后重新请求：

```powershell
Invoke-RestMethod "$BaseUrl/api/health/ready"
$live = Invoke-RestMethod "$BaseUrl/api/deals"
$live.meta
$live.data.Count
```

并刷新浏览器，确认 API 新数据最终出现在 UI 中。

### 6.4 数据库只读核对

可在 Supabase SQL Editor 中执行以下**只读查询**。不要在这里执行迁移 DDL。

```sql
-- 最近采集是否成功、耗时是否合理、有没有遗留 running/failed
select id, retailer_slug, store_source_id, status, offers_seen,
       started_at, finished_at, error_message, metadata
from public.collection_runs
order by started_at desc
limit 20;

-- 当前各零售商/门店可见优惠数量和最新采集时间
select retailer_name, store_name, count(*) as deal_count,
       max(collected_at) as latest_collected_at
from public.current_deals
group by retailer_name, store_name
order by retailer_name, store_name;

-- 会员价、促销价和常规价是否被分开保存
select promotion_type, count(*)
from public.current_deals
group by promotion_type
order by promotion_type;

-- 价格单位和有效价格的基本异常检查
select count(*) as invalid_price_rows
from public.current_deals
where effective_price_cents <= 0
   or (regular_price_cents is not null and regular_price_cents <= 0);

-- 价格历史是否只在内容变化时增长，并能关联到当前商品/门店
select oh.retailer_product_id, oh.store_id, count(*) as history_points,
       min(oh.observed_at) as first_seen, max(oh.observed_at) as last_seen
from public.offer_history oh
group by oh.retailer_product_id, oh.store_id
order by last_seen desc
limit 20;
```

检查重点：

- 每个零售商/门店最多只有一条 `status = 'running'` 的记录。
- 正常采集最终为 `succeeded` 且 `finished_at` 非空。
- 当前优惠数量不是异常归零，也没有明显重复商品。
- `effective_price_cents` 为正整数 NZ cents。
- 会员价不会错误写入普通促销价字段。
- 图片迁移到 Blob 后 URL 位于 `product-images/`；单张图片复制失败不应导致整轮价格采集失败。

## 7. 第四阶段：远程生产实例

### 7.1 锁定本次测试对象

不要使用含糊的 Preview URL。记录正式域名、部署 URL、Git commit SHA、测试时间和测试人：

```powershell
$BaseUrl = 'https://YOUR_PRODUCTION_DOMAIN'
vercel inspect $BaseUrl
```

先确认该 URL 是当前 Production 部署。生产发布由 `.github/workflows/production.yml` 管理：测试、类型检查、Lint、数据库迁移、readiness、Vercel 构建都成功后才部署。还应检查对应 GitHub Actions workflow 全绿。

### 7.2 生产只读冒烟测试

以下检查可以先执行，不会写业务数据：

```powershell
curl.exe -sS -i "$BaseUrl/"
curl.exe -sS -i "$BaseUrl/api/health/ready"
curl.exe -sS -i "$BaseUrl/api/deals"
curl.exe -sS -i "$BaseUrl/api/deals?q=milk&minDiscount=5"
curl.exe -sS -i "$BaseUrl/api/products/does-not-exist"
curl.exe -sS -i "$BaseUrl/api/cron/woolworths"
curl.exe -sS -i -H "Authorization: Bearer wrong-token" "$BaseUrl/api/cron/paknsave"
curl.exe -sS -i "$BaseUrl/api/internal/apply-migration"
```

预期依次为：

- 首页 `200`。
- readiness `200`、`ready: true`、schema `20260831160000`。
- deals `200`、`meta.demo: false`、数据结构完整且 `Cache-Control` 为 `no-store`。
- 带查询的 deals 仍为 `200`，每条数据满足条件。
- 不存在商品 `404`。
- 两个未授权 Cron 请求均为 `401`。
- 禁止存在的 HTTP 迁移路由为 `404`。

再从真实列表取一个 ID 检查商品详情：

```powershell
$productionDeals = Invoke-RestMethod "$BaseUrl/api/deals"
if ($productionDeals.data.Count -lt 1) { throw 'Production deals is unexpectedly empty' }
if ($productionDeals.meta.demo -ne $false) { throw 'Production is incorrectly serving demo data' }
$id = [uri]::EscapeDataString($productionDeals.data[0].id)
$product = Invoke-RestMethod "$BaseUrl/api/products/$id"
if ($product.data.id -ne $productionDeals.data[0].id) { throw 'Product detail ID mismatch' }
```

若在某一层发现失败，先停止向下测试并保存证据。例如 `/api/health/ready` 为 `503` 时，应先修复环境变量或数据库 schema，不要继续执行真实采集。

### 7.3 生产 UI 回归

在无痕窗口执行第 5.3 节全部用例，额外确认：

- 页脚不是 Preview 模式。
- 首页统计、零售商和门店与 `/api/deals` 返回值一致。
- 至少抽查 Woolworths 和 PAK'nSAVE 各一个商品；价格、会员标签、门店、图片和详情一致。
- 更新时间和采集时间符合 `Pacific/Auckland`，没有把 UTC 直接当作奥克兰本地时间。
- 强制刷新后依然读取最新 API 数据，没有 CDN 旧 JSON。
- 页面源码的 title、description 和 Open Graph 图片正确，正式环境 `SITE_URL` 没有指向 localhost。

建议在 Chrome、Firefox、Safari/WebKit 至少各做一次关键流程，并在手机尺寸重复搜索、筛选和详情弹窗流程。

### 7.4 获授权后的生产采集验证

只有在以下条件全部满足时才能继续：

- 已确认 Production URL 和当前部署版本。
- readiness 为 `200`。
- GitHub Actions 的数据库迁移和部署步骤成功。
- 已检查当前没有同门店的 `running` 采集。
- 已告知相关人员本次测试会写生产数据并调用外部零售商。
- 有查看 Vercel Function Logs 和 Supabase 数据的权限。

先打开实时日志：

```powershell
vercel logs $BaseUrl --follow
```

在另一个终端一次调用一个采集器：

```powershell
$CronSecret = Read-Host 'Production CRON_SECRET' -MaskInput
curl.exe -sS -i --max-time 310 -H "Authorization: Bearer $CronSecret" "$BaseUrl/api/cron/woolworths"
# 完成并核对后，再决定是否执行下一条
curl.exe -sS -i --max-time 310 -H "Authorization: Bearer $CronSecret" "$BaseUrl/api/cron/paknsave"
Remove-Variable CronSecret
```

每轮完成后立即核对：

1. HTTP `200` 且 `ok: true`。
2. 响应门店是预期门店：Woolworths 默认 Glenfield（source id `9171`），PAK'nSAVE 默认 Royal Oak。
3. `pagesCollected`、`totalItemsReported` 和持久化数量非异常值。
4. Vercel 日志没有未处理异常、密钥、Cookie 或完整 Authorization Header。
5. `collection_runs` 最终为 `succeeded`，没有残留 `running`。
6. `/api/deals` 的 `meta.updatedAt` 更新，数据没有异常清空。
7. 首页刷新后显示新数据，商品详情和 90 天历史仍可读取。

生产 Cron 配置为每天 `17:10 UTC` 和 `17:25 UTC`。这对应奥克兰标准时约次日 `05:10/05:25`，夏令时约次日 `06:10/06:25`。定时任务只在 Production 部署运行；测试后还要在 Vercel Cron/Logs 中确认下一次自动调度正常。

## 8. 性能、稳定性和安全补充检查

功能通过后再执行这些非功能门槛：

- 用 Chrome 无痕窗口运行 Lighthouse 的 Performance、Accessibility、Best Practices 和 SEO。
- 在 Network 中模拟 Slow 4G，确认首屏有合理反馈，刷新按钮不会重复提交。
- 连续快速点击 Refresh，确认不会造成界面错乱或大量并发请求。
- 验证静态资源长缓存，而 `/api/deals` 和 readiness 不被 CDN 缓存。
- 验证只有非敏感变量可以使用 `NEXT_PUBLIC_`；Supabase secret、Cron secret 和 Woolworths Cookie 永远不进入客户端 bundle。
- 搜索公开 JS 和 HTML 响应，确认没有数据库密钥、Bearer Token、Cookie、内部错误堆栈或 Supabase管理凭据。
- 对 Cron 只做少量已知错误 Token 测试，不进行暴力测试。
- 检查 Supabase 的 `anon`/`authenticated` 角色不能直接读取这些业务表和 `current_deals`，应用只通过服务端密钥读取。
- 查看最近失败采集、函数耗时和 300 秒超时风险；确认失败不会把不完整快照标记为当前数据。

## 9. 推荐的发布回归顺序

每次发布按以下顺序执行，能够最快定位失败边界：

```text
1. npm test
2. npm run typecheck
3. npm run lint
4. npm run build
5. 测试 Supabase migration list / db push --dry-run
6. npm run release:ready
7. 本地生产模式 API + UI
8. GitHub Actions 部署全绿
9. 生产 readiness
10. 生产只读 API 冒烟
11. 生产 UI 关键路径
12. 经授权的真实采集
13. 数据库、日志和前台闭环核对
```

## 10. 测试记录模板

复制下面内容到每次发布记录中：

```markdown
## Auckland Bargain 验证报告

- 环境：本地 Demo / 本地生产模式 / Preview / Production
- Base URL：
- Commit SHA / Deployment URL：
- 测试时间（Pacific/Auckland）：
- 测试人：

| 边界 | 状态 | 证据 |
| --- | --- | --- |
| 自动化测试、类型、Lint、构建 | 通过/失败 | 命令退出码或日志链接 |
| 首页渲染 | 通过/失败 | 截图、Console、Network |
| 浏览器 -> `/api/deals` | 通过/失败 | 状态码、meta、样例响应 |
| `/api/deals` -> Supabase | 通过/失败 | readiness、只读 SQL 结果 |
| Cron 鉴权 | 通过/失败 | 401 响应 |
| 采集器 -> 零售商 | 通过/失败/未执行 | 函数日志、页数、门店 |
| 采集器 -> Supabase | 通过/失败/未执行 | run id、status、offers_seen |
| 新数据 -> UI | 通过/失败/未执行 | updatedAt、页面截图 |

### 发现的问题

1. 问题：
   - 复现步骤：
   - 实际结果：
   - 预期结果：
   - Console/Network/日志证据：
   - 首个失败边界：UI / API / 外部接口 / 数据库 / 响应渲染

### 结论

- 可以发布 / 阻断发布
- 未执行项及原因：
- 后续负责人：
```

测试证据应包含状态码、关键响应字段、部署标识和时间，但必须删去 Token、Cookie、Supabase 密钥及任何个人信息。
