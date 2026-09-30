# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / warehouse（台账对账）
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore / mergeStore（对账合并）
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / Reconcile（台账对账）
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / merge.ts（对账引擎）（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |
| `/reconcile` | 台账对账 | 现场离线岩芯箱与岩芯库出入库台账合并对账：现场编录口径与库管架位/借出口径按字段归属合并，两边都动过同一字段时两版都留着逐条认 |

## 台账对账（合并对账）

现场编录员在笔记本上离线记的岩芯箱，需要和岩芯库的出入库台账合并对账。口径与规则：

- **现场算**：回次、岩性、破损格与结构（箱号 / 深度区间 / 格数 / 每格长度 / 装箱人）。
- **库管算**：库架位、借出状态（在库 / 借出）。
- **两版都留着**：同一个岩芯箱两边都动过同一字段（相对上一版基线）时，自动判为冲突，现场版与库管版都落库并挂起，界面上逐条对比、逐条认（保留现场版 / 保留库管版）。
- **失败先保上一版、按侧重试**：落库前先把当前箱表快照到 `meta`；现场侧与库管侧分两个事务分别写入，任一侧失败都恢复上一版结果，并可按「现场侧 / 库管侧」单独重试。
- **同一份台账不重复**：以 `ledgerId` 批次号 + 上一版基线双重幂等，重复送达只报「重复未变」，不多出记录。

操作：`台账对账` 页 →「导出现场台账（送岩芯库）」可生成现场版 JSON；岩芯库台账稍作改动后「导入岩芯库台账（JSON）」→ 预览自动合并 / 两版待认 / 仅现场 / 仅库管 / 重复未变 →「执行合并落库」→ 冲突箱逐条认。

岩芯箱在 `CoreBox` 上以 `mergeSide`（field / warehouse / merged）、`mergeGroupId`（冲突两版共用）、`mergeStatus`（pending / kept-field / kept-warehouse）标记对账来源；基线与已应用台账批次号存于 `meta` 表（`merge-baseline` / `merge-applied-ledgers` / `pre-merge-snapshot`）。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 为岩芯箱增加借出状态与对账来源/冲突标记并回填「在库」。升级前可用顶栏「导出备份」导出全量 JSON。
- 台账对账的基线、已应用批次号、合并前快照存于 `meta` 表（`merge-baseline` / `merge-applied-ledgers` / `pre-merge-snapshot`）。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
