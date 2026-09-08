# 重构进度与续作入口

更新时间：2026-09-09（新西兰时间）。核心本地流程已可运行，部署方式已从 Vercel 换成自有服务器上的容器编排，但全国全量覆盖与生产自动采集尚未完成。

## 已实现并验证

- 搜索 → 地区、分类、超市筛选 → 商品比价 → 历史观察 → 跳转原始门店；返回搜索保留查询条件。
- 服务端分页，每页默认 24 个商品，不把完整目录传给首页客户端。
- 商品匹配采用条码或品牌、名称、规格、分类证据；规格、数字型号和受保护变体冲突不会自动合并。
- 六个超市品牌的独立每周定时任务配置、鉴权、请求重试、采集完整性校验和数据库租约。
- 报价先暂存，再以事务发布完整门店快照；不完整或过期任务不能发布部分价格。
- 按新西兰自然周保留最新与上一条观察。同周重跑替换本周记录，不挤掉上一周；门店历史互相隔离。
- 价格变化只比较前后都有记录的同一组报价。新增便宜门店不会被标成降价；上一条记录不被误称为“上周”。
- 商品 SKU 与门店报价 ID 分离。相同 SKU 可跨门店分组，每家店的报价和历史独立；刷新单店不再替换整个超市品牌的其他门店数据。旧 ID 历史迁移和 API 查询兼容已保留。
- 门店注册表、按新西兰自然周生成的只读计划和逐店本地批量入口已实现。本周成功的门店会跳过，失败门店保留旧快照后重试；许可待确认、过期、凭据缺失和目录不支持均明确阻止执行。当前六家注册门店全部为许可待确认。
- 两个本地刷新入口共用文件锁和原子替换；成功门店逐个保存，磁盘写入失败立即停止。新目录方法支持 PAK’nSAVE／New World，并保留每店南北岛上下文；这些新增目录方法只做了离线测试。
- Woolworths 补齐总量一致性、缺失 SKU 和重复分页检查，识别到但无可用价格的商品单独计数。自定义 MyFoodLink 门店不再继承样例店的城市与地址。
- 持久化任务队列（`collection_targets` / `collection_jobs`）：按门店、采集范围和新西兰自然周去重入队；领取带租约与配置版本围栏，失败三次退避重试，过期租约由数据库回收；发布前在价格事务内复查租约、配置、门店身份与周次，权限被撤销会连同价格与历史一起回滚；响应丢失时已提交的成功不会被改回失败。
- 队列运维命令：`queue:sync`（默认只预览）、`queue:status`、`queue:enqueue`、`queue:work`。同步是显式操作，任何请求路径都不会顺带写入门店配置。
- 商品图片镜像写在服务器自己的磁盘上（`PRODUCT_IMAGE_DIR`，容器里是挂载卷），由 `/product-images/*` 路由或反向代理直接提供。是否已镜像仍由 Postgres 的 `product_image_mirrors` 索引回答，同一品牌其他门店的相同商品直接命中索引；抓取失败的图片记录 30 天退避。磁盘上限由 `PRODUCT_IMAGE_MIRROR_MAX_BYTES` 控制（默认 8 GiB），超出后回退到超市原图 URL 而不是把卷写满。索引丢失时，磁盘上已存在的文件通过一次 `stat` 复用，不会重新下载。`PRODUCT_IMAGE_MIRROR=off` 可停止新增镜像但继续提供已存图片。恢复备份或换机后用 `npm run images:index` / `images:index:adopt`，或线上 `GET /api/cron/images?execute=true` 补登记。
- `/api/cron/collect` 已接入队列并按小时调度：每次入队本周合格门店，最多领取 3 个任务（`?limit=` 上限 10，`?retailer=` 可限定品牌），超过 120 秒不再领取新任务，把剩余执行时间留给进行中的任务。合格性由数据库的 `collection_target_block_reason` 判定，当前六家门店全部 `access: pending`，因此该路由目前入队为 0、不请求任何超市。

本地快照生成于 `2026-09-05T13:53:12.098Z`，包含 13,188 条报价、11,062 个比较商品，其中 1,859 个有跨超市匹配。这里的“商品”是程序分组结果，不代表人工认证的匹配准确率。

| 品牌        | 当前指定门店报价数 |
| ----------- | -----------------: |
| Woolworths  |              5,076 |
| PAK'nSAVE   |              2,270 |
| New World   |              2,028 |
| Four Square |                 45 |
| FreshChoice |              2,626 |
| SuperValue  |              1,143 |

## 最后验证结果

- `npm test`：187 项通过，包含在独立 PGlite/Postgres 环境执行所有迁移和事务回滚测试，以及完整目录采集、范围选择、多门店报价隔离、逐店计划与失败重试、文件并发保护、目录身份、持久化队列（去重入队、退避重试、过期租约回收、许可撤销回滚、响应丢失保护）、调度路由（任务上限、领取截止、空队列、失败上报、鉴权与参数校验）、图片镜像索引（索引命中零磁盘操作、跨门店复用、失败退避、每次运行上限与磁盘上限、开关关闭、索引不可读时回退、磁盘文件复用与补登记）、文件存储（写入原子性、越界路径拒绝）、直连 Postgres 驱动（过滤/排序/分页、单行读取、in 与 overlaps、内嵌关联过滤、upsert 与冲突更新、条件更新、命名参数 RPC 与 jsonb 往返、错误不抛出、标识符注入拒绝）和调度容器配置（默认排期渲染、环境变量覆盖、`off` 关闭、非法表达式与时区拒绝、密钥文件权限）测试。
- `npm run lint:type-aware`：通过。
- `npm run build`：通过，包含 TypeScript 检查。
- `npx tsx scripts/verify-comparison-app.ts`：本地生产服务器检查通过，覆盖分页、搜索、地区报价、详情、返回链接、缺失商品和定时任务鉴权；新增的 `/api/cron/collect`（含带参数形式）同样返回 401。
- `npm run stores:plan`：本地预览通过，六家门店显示明确阻止原因，没有请求来源。对许可待确认的 FreshChoice 执行测试返回预期退出码 1，快照哈希未变，文件锁正常释放。
- 首页 HTML 约 449 KB；全量商品匹配在本机约 0.7 秒。这不是生产负载测试结果。
- 浏览器验收已补做（本地生产服务器，端口 3100）：搜索 `milk` 得 353 个商品，切换 Auckland 后为 350；商品详情正确展示 New World / PAK'nSAVE / Woolworths 三家按实付价排序的报价、各店采集日期、94% 匹配置信度与匹配理由；「Back to search」保留 `?q=milk&city=Auckland`；控制台无错误。375×812 移动视口下无横向溢出（`scrollWidth` = 375），商品卡宽 311px，Compare 按钮高 44px。隐藏浏览器面板时滚动截图为空白属于截图限制，不是页面渲染问题，因此移动端是按布局度量而非逐屏截图确认的。
- `npm run release:ready`：未通过，当前未配置 Supabase 和 `CRON_SECRET`。没有执行生产迁移或部署，没有验证线上每周任务。

## 部署方式迁移（2026-09-09）

从 Vercel 换成自有服务器（Vultr + 宝塔面板）上的容器编排，功能行为不变：

- 数据库现在有两个驱动，调用方只依赖 `db/client.ts` 里的窄接口：Supabase 走
  `@supabase/supabase-js`，自建 Postgres（含宝塔 PostgreSQL 管理器装的版本）走
  `db/postgres/rest.ts` 的直连实现。后者把应用实际用到的 PostgREST 调用形态翻译成
  SQL，并在 `test/postgres-client.test.ts` 里对着跑完全部迁移的真实库逐条验证。
  两者都配置时 `DATABASE_URL` 优先，`DATABASE_DRIVER` 可强制指定。
- 迁移由 `scripts/migrate.mjs` 执行（`npm run db:migrate`），对 Supabase 直连串和自建库
  用同一套 SQL，记录写在 Supabase CLI 用的 `supabase_migrations.schema_migrations`，
  两种工具不会重复执行同一个文件；自建库缺少的 `anon`/`authenticated`/`service_role`
  角色由脚本补建。
- 图片存储从 Vercel Blob 换成本地目录，按月计费的操作额度换成按磁盘的容量上限，
  新增迁移 `20260909120000_self_hosted_image_store.sql`（`blob_url` 改名 `stored_url`、
  新增 `byte_size`、删除 `blob_upload_budget` 与 `claim_blob_upload_slots`、
  新增 `product_image_store_bytes()`）。
- 定时任务从 `vercel.json` 换成 `deploy/cron-jobs.json` 加一个 Alpine + busybox crond
  的 `scheduler` 容器。排期按 `CRON_TZ`（默认 `Pacific/Auckland`）解释，每个任务都能用
  环境变量改时间或设 `off` 关闭；表达式非法、时区未知或缺 `CRON_SECRET` 时容器直接
  拒绝启动，不会带着一个永不触发的排期跑着。原来的六个周任务从 UTC 周日改写成
  新西兰时间周一，间隔仍是 70 分钟。
- 队列每次领取的任务数和领取截止时间改为环境变量（`COLLECTION_JOB_LIMIT`、
  `COLLECTION_JOB_MAX_LIMIT`、`COLLECTION_CLAIM_DEADLINE_MS`）。这两个数原本是被
  300 秒函数上限逼出来的。
- `Dockerfile`（standalone 输出）、`docker/scheduler/Dockerfile` 和 `docker-compose.yml`
  组成两容器加一个卷的部署；`--profile migrate` 是一次性迁移任务。
  新增 `/api/health/live` 供容器健康检查使用，`/api/health/ready` 保持原语义。
- GitHub Actions：`ci.yml` 在每个 PR 上跑测试、类型检查、Lint 和构建；
  `docker-publish.yml` 在 PR 上构建两个镜像但不推送，合并进 `main` 后推到仓库所有者的
  GHCR（`ghcr.io/<owner>/auckland-bargain` 和 `-scheduler`），标签含 `latest`、
  `sha-<commit>` 和语义化版本。
- 中文部署教程见 [deploy-baota.md](deploy-baota.md)，覆盖宝塔的数据库、反向代理、
  HTTPS、卷备份、升级回滚和常见故障。

线上服务器上还没有按这套流程实际部署过，镜像也还没有在 GHCR 上构建过一次。

## 浏览体验修复（2026-09-08）

针对线上部署（`http://45.32.189.81/`）实测到的可用性问题：

- 比较目录读取加了进程内快照（`lib/repositories/comparison-source.ts`，TTL 由 `COMPARISON_SNAPSHOT_MS` 控制，默认 5 分钟），并对并发冷启动去重。此前数据库路径每次请求都要全表分页读 `current_deals` 与 `offer_history` 并重建全部比较商品，线上每次筛选约 6 秒，看起来像点了没反应；本机生产服务器现为 20–40 毫秒。
- 主色由 `#059669` 改为 `#047857`，前景色由 `#052e16` 改为 `#ffffff`。原组合在按钮上只有 3.96:1，`text-primary` 小字只有 3.58–3.77:1，均低于 WCAG AA 的 4.5:1；新组合为 5.2–5.5:1。深色主题的对比度本就达标，未改动。
- 侧栏分类：默认按商品数排序展示前 8 个（原为字母序，前 7 个都是只有 1–4 件商品的长尾分类）；当前选中的分类即使不在默认列表里也会保留显示并带 `aria-pressed`；展开后带分类搜索框和滚动容器（共 334 个分类）；展开状态不再因为筛选导航被重置。
- 筛选反馈：点击后立即高亮目标选项，结果区变暗并显示加载指示与「Updating results…」，`aria-busy` 同步。
- 翻页后回到结果区顶部（结果卡片使用 `content-visibility`，`scrollIntoView` 与平滑滚动都不可靠，改为按实测偏移直接跳转）。
- 移动端结果卡改为缩略图加文字的两列布局，卡片高度由约 1000px 降到约 480px。

## 尚未完成

1. 全国门店与独立超市覆盖：目前是六个品牌的指定门店，不是全国所有门店。本地注册表、数据库持久化队列、自动重试与按小时的有界调度已完成；仍需实际门店发现/导入与覆盖状态监控。旧的六个按品牌定时路由仍是环境变量指定的单店任务，不读注册表也不校验许可，需在对应门店成为已批准队列目标后逐个下线，避免同一门店一周被采两次。队列的默认容量为每周约 504 个门店任务，全国规模需要按门店数量重新核算 `COLLECTION_JOB_LIMIT` 与调度频率。
2. 常规商品目录：FreshChoice／SuperValue 的完整分类目录适配器已实现并接入周任务和本地刷新，包含原价商品、递归分类、逐页门店校验、去重与完整性检查。离线测试通过，少量真实页面验证通过，但尚未完成整个门店目录的真实抓取验收；当前打包快照仍是旧促销数据。其余四个品牌仍只支持促销目录。来源再发布许可尚未确认，见 [source-access-review.md](source-access-review.md)。
3. 匹配复核工具：模糊候选已写入数据库复核队列，但人工确认、拆分、覆盖匹配和审计的管理界面尚未实现。
4. 生产接入：在服务器的 `.env` 中配置 `DATABASE_URL`（或 Supabase 的三个变量）与 `CRON_SECRET`，跑 `docker compose --profile migrate run --rm migrate` 后再 `up -d`；图片磁盘上限按卷大小调整 `PRODUCT_IMAGE_MIRROR_MAX_BYTES`，从旧环境搬来的图片跑一次 `/api/cron/images?execute=true` 补登记。不要把密钥贴到聊天或提交仓库。
5. 上线验收：迁移目标数据库，运行受保护的首次采集，验证真实数据库的报价和历史，再部署并观察每周调度。数据库事务目前保证价格与历史的原子发布，不包含之前写入的全部商品元数据。

## 继续工作

本地启动和只读验证：

```bash
npm run build
npm run start -- --port 3100
# 在另一个终端：
npx tsx scripts/verify-comparison-app.ts
```

下一项不依赖生产凭据的工作是其余四个品牌的常规目录适配，以及 Woolworths／MyFoodLink 的门店发现与导入。许可感知的持久化任务分发与有界调度已经完成，队列本身只能用真实 Supabase 凭据做上线验收。需要先补齐合法可用的数据来源，才能开展全国批量抓取与上线验收。详细结构见 [product-comparison-architecture.md](product-comparison-architecture.md) 与 [store-registry.md](store-registry.md)。
