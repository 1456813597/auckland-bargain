# 在宝塔面板上用 Docker 部署

这份文档写给要把 Auckland Bargain 跑在自己 Vultr（或任何一台 Linux VPS）上的人。
原来的部署依赖 Vercel：Blob 存图片，Vercel Cron 触发抓取。现在这两件事都搬进了
自己的容器，图片写进服务器磁盘，定时任务由一个 `scheduler` 容器负责。

整套东西是两个容器加一个卷：

- `app`：Next.js 站点，同时提供 `/api/cron/*` 抓取入口和 `/product-images/*` 图片。
- `scheduler`：一个只有十几兆的 Alpine 容器，按点调用上面那些接口。
- `product-images` 卷：镜像下来的商品图。

数据库不在容器里。你可以继续用 Supabase，也可以用宝塔的 PostgreSQL 管理器装一个，
应用两种都支持，改一个环境变量就能切换。

## 一、准备服务器

在宝塔面板里装两样东西：

1. 软件商店里的 **Docker 管理器**（会一并装好 docker 和 docker compose）。
2. 如果打算自建数据库，再装 **PostgreSQL 管理器**，选 15 或更高的版本。

然后在 SSH 里确认一下版本，compose 至少要 v2：

```bash
docker --version && docker compose version
```

安全组和面板防火墙只需要放行 80 和 443。应用容器默认只监听 `127.0.0.1:3000`，
由面板的网站反向代理转发，不直接对外。

## 二、准备数据库

### 方案 A：宝塔自建 PostgreSQL

在 PostgreSQL 管理器里新建一个数据库，比如叫 `auckland_bargain`，同时新建用户
`auckland` 并给它这个库的全部权限。迁移和应用用同一个用户，因为表是它建的，
它才是表的属主，行级安全策略不会挡住自己人。

如果数据库和容器在同一台机器上，连接串写宿主机的内网地址：

```
DATABASE_URL=postgresql://auckland:你的密码@172.17.0.1:5432/auckland_bargain
```

`172.17.0.1` 是 Docker 默认网桥上的宿主机地址。用 `docker network inspect bridge`
可以确认。另外要允许容器网段连进来：在 PostgreSQL 管理器的配置里，把
`listen_addresses` 设成 `*`，并在 `pg_hba.conf` 里加一行

```
host    auckland_bargain    auckland    172.17.0.0/16    scram-sha-256
```

改完重启 PostgreSQL。这个网段只在本机内部可达，但仍然建议给数据库用户设一个长密码。

### 方案 B：继续用 Supabase

保留原来的三个变量就行：

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SECRET_KEY=你的 service key
POSTGRES_URL_NON_POOLING=postgresql://postgres:...@db.xxxx.supabase.co:5432/postgres
```

应用走 Supabase 的 REST 接口读写，迁移走那条直连串。

两套都填了会怎样？`DATABASE_URL` 优先。想强制走某一边，就设
`DATABASE_DRIVER=postgres` 或 `DATABASE_DRIVER=supabase`。

## 三、放代码和配置

镜像是 GitHub Actions 构建好推到 GHCR 的，服务器上只需要 `docker-compose.yml`
和 `.env`。最省事的办法还是把仓库拉下来：

```bash
mkdir -p /www/wwwroot/auckland-bargain && cd /www/wwwroot/auckland-bargain
git clone https://github.com/1456813597/auckland-bargain.git .
cp .env.example .env
```

然后编辑 `.env`。至少要改这几项：

```
DATABASE_URL=...          # 或者填 Supabase 那三个
CRON_SECRET=              # 至少 16 位随机字符
SITE_URL=https://你的域名
```

`CRON_SECRET` 用这条命令生成，别自己想一个：

```bash
openssl rand -hex 24
```

抓取接口只认这个 Bearer token，没有它谁都调不动，包括你自己。

## 四、建表

第一次部署，以及以后每次更新镜像，都要先把迁移跑完再启动站点：

```bash
docker compose --profile migrate run --rm migrate
```

这条命令用的是应用镜像本身，里面带着 `supabase/migrations` 下的全部 SQL。
它会记在 `supabase_migrations.schema_migrations` 表里，和 Supabase CLI 用的是同一张表，
所以两边不会重复执行同一个文件。自建库上缺少的 `anon`、`authenticated`、`service_role`
角色，脚本会自己补出来。

想先看会执行哪些文件，不真的执行：

```bash
docker compose --profile migrate run --rm migrate node scripts/migrate.mjs --dry-run
```

## 五、启动

```bash
docker compose pull
docker compose up -d
docker compose ps
```

`app` 的状态变成 healthy 之后，验证一下：

```bash
curl -s http://127.0.0.1:3000/api/health/live
curl -s http://127.0.0.1:3000/api/health/ready
```

`live` 返回 `{"alive":true}` 说明进程活着。`ready` 会去查数据库，返回 200 表示
迁移到位；返回 503 时它会列出哪一项没通过，照着看就行。

## 六、面板里配好域名和 HTTPS

在宝塔的「网站」里新建一个站点，绑定你的域名，不用装 PHP。建好后进「反向代理」，
目标地址填 `http://127.0.0.1:3000`，发送域名填 `$host`。再去「SSL」申请一张
Let's Encrypt 证书，打开强制 HTTPS。

反向代理配置里加两条，商品图和 Next.js 的静态资源体积不小，缓存和上传大小都要放宽：

```nginx
client_max_body_size 20m;
proxy_read_timeout 1800s;
```

`proxy_read_timeout` 调大是给手动触发抓取用的。一次全目录采集跑十几分钟很正常，
默认 60 秒会在中途断掉连接。

图片默认由 `app` 容器自己提供。如果想让 nginx 直接读卷、少走一层 Node，
先找到卷在宿主机上的路径：

```bash
docker volume inspect auckland-bargain_product-images --format '{{.Mountpoint}}'
```

然后在站点配置里加：

```nginx
location /product-images/ {
    alias /var/lib/docker/volumes/auckland-bargain_product-images/_data/;
    expires 365d;
    add_header Cache-Control "public, immutable";
}
```

不加也能正常工作，只是每张图多走一次 Node 进程。

## 七、定时抓取

时间表在 `deploy/cron-jobs.json` 里，容器启动时读它生成 crontab。每个任务都能用
环境变量覆盖，不用改文件：

| 任务        | 变量                        | 默认时间（新西兰时间） |
| ----------- | --------------------------- | ---------------------- |
| 队列调度    | `CRON_COLLECT_SCHEDULE`     | 每小时                 |
| Woolworths  | `CRON_WOOLWORTHS_SCHEDULE`  | 周一 04:10             |
| PAK'nSAVE   | `CRON_PAKNSAVE_SCHEDULE`    | 周一 05:20             |
| New World   | `CRON_NEWWORLD_SCHEDULE`    | 周一 06:30             |
| Four Square | `CRON_FOURSQUARE_SCHEDULE`  | 周一 07:40             |
| FreshChoice | `CRON_FRESHCHOICE_SCHEDULE` | 周一 08:50             |
| SuperValue  | `CRON_SUPERVALUE_SCHEDULE`  | 周一 10:00             |

时区由 `CRON_TZ` 决定，默认 `Pacific/Auckland`。写的是本地时间，夏令时切换时不用管，
容器里装了 tzdata 会自己跟着走。六个品牌任务错开 70 分钟，是为了不让两次采集撞在一起。

改时间就在 `.env` 里写，比如：

```
CRON_COLLECT_SCHEDULE=*/30 * * * *
CRON_FOURSQUARE_SCHEDULE=off
```

`off` 表示这个任务不排。改完重启调度容器：

```bash
docker compose up -d scheduler
docker compose logs scheduler | head -20
```

日志开头会把最终排期一条条打印出来，对不上说明变量名写错了。每次任务跑完也会打一行 JSON，
带状态码和响应摘要，排查时直接看这个：

```bash
docker compose logs -f scheduler
```

想立刻跑一次而不等排期：

```bash
source .env
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/collect?limit=1"
```

顺带一提，队列任务每次最多领几个门店由 `COLLECTION_JOB_LIMIT` 控制，默认 3。
以前这个数字是被 Vercel 的 300 秒函数上限逼出来的，现在服务器是自己的，
按机器扛得住的量往上调就行，`COLLECTION_CLAIM_DEADLINE_MS` 同理。

## 八、商品图片

镜像下来的图写在 `product-images` 卷里，数据库的 `product_image_mirrors` 表记录
哪张图已经存过、多大、失败的下次什么时候再试。`PRODUCT_IMAGE_MIRROR_MAX_BYTES`
是磁盘上限，默认 8 GiB，写满之后不会撑爆磁盘，只是新图继续用超市的原始链接。

不想再存新图但保留已有的：

```
PRODUCT_IMAGE_MIRROR=off
```

从别的机器搬过来、或者恢复了卷的备份，索引和文件可能对不上。这时候让容器扫一遍卷，
把磁盘上有、索引里没有的图补登记进去：

```bash
source .env
# 先看会登记多少，不写库
curl -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/images
# 确认数字合理后再写
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/images?execute=true"
```

这个接口和抓取接口用同一个密钥，跑两次的结果和跑一次一样。本地开发时也可以用
`npm run images:index` 和 `npm run images:index:adopt`，做的是同一件事。

备份就是备份那个卷：

```bash
docker run --rm -v auckland-bargain_product-images:/data -v $PWD:/backup \
  alpine tar czf /backup/product-images-$(date +%F).tar.gz -C /data .
```

## 九、更新到新版本

上游合并 PR 之后，GitHub Actions 会构建新镜像并推到 GHCR。服务器上三条命令：

```bash
cd /www/wwwroot/auckland-bargain && git pull
docker compose pull
docker compose --profile migrate run --rm migrate && docker compose up -d
```

`git pull` 是为了拿到新的 compose 文件和时间表，镜像本身来自 GHCR。迁移和启动写在
一条命令里，用 `&&` 连着，迁移失败就不会换成新版站点。

如果仓库的 package 设成了私有，服务器要先登录一次。用一个只勾了 `read:packages`
的 GitHub token：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u 你的GitHub用户名 --password-stdin
```

回滚就是把 `.env` 里的 `APP_IMAGE` 换成带 sha 的那个 tag，再 `up -d`。每次构建都会推
`sha-<完整提交号>`，在 GitHub 仓库右侧的 Packages 里能看到全部标签。

## 十、出问题时先看哪里

站点打不开，先分清是容器没起来还是代理没通：

```bash
docker compose ps
docker compose logs --tail 100 app
```

`ready` 返回 503，看返回体里的 `checks`。`databaseConfigured: false` 是连接串没读到，
其余几项为 false 通常是迁移没跑完。

抓取任务全部 401：`app` 和 `scheduler` 读到的 `CRON_SECRET` 不一致。两个容器都用同一个
`.env`，但改完必须两个都重启，`docker compose up -d` 会处理。

数据库连不上，在容器里试一次，能立刻分清是网络还是认证：

```bash
docker compose exec app node -e "
const pg=require('pg');
new pg.Client({connectionString:process.env.DATABASE_URL}).connect()
  .then(()=>console.log('ok')).catch(e=>console.log(e.message))"
```

`no pg_hba.conf entry` 是第二步那行没加或没重启；`ECONNREFUSED` 是地址或端口不对；
`password authentication failed` 就只是密码。

图片 404，多半是 `PRODUCT_IMAGE_DIR` 和卷的挂载点不一致。容器里默认是
`/data/product-images`，compose 里的 volume 也挂在这，两边别改成不一样的值。

调度容器起不来，日志第一行会直说原因：缺 `CRON_SECRET`、时区名写错、或者某个
cron 表达式不是五段。它宁可起不来也不会带着一个永远不触发的排期偷偷运行。
