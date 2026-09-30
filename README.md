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
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore / reconcileStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`） |
| 测试 | Vitest + fake-indexeddb（合并引擎与对账服务，`npm test`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
npm test         # 运行 Vitest 单元测试
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
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / reconcile
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore / reconcileStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / Reconcile / LithoEditor
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery / db / export / reconcile-engine / reconcile-service（+ seed / id，含 *.test.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验、箱内回次/岩性、借出状态 |
| `/reconcile` | 对账合并 | 现场离线岩芯箱与岩芯库出入库台账三向合并对账（字段按侧归属、两侧同改两版同留、失败保住上一版并按侧重试、台账幂等） |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`conflicts`、`reconcileState`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD；`db.version(3).upgrade(...)` 为岩芯箱补 `loanStatus`（借出状态）并新增 `conflicts`（两版同留分歧）与 `reconcileState`（上一版结果快照 + 已处理台账登记）两张表。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 现场岩芯箱 × 岩芯库台账 对账规则（`/reconcile`）

现场编录员离线笔记本上的岩芯箱，与岩芯库另存的出入库台账按**归一化箱号**匹配合并（`src/utils/reconcile-engine.ts` 纯函数三向合并 + `src/utils/reconcile-service.ts` 事务落库）：

- **字段按侧归属**：箱内回次、主要岩性、破损格等现场字段以现场离线版为准；库架位、借出状态（在库/借出/归还中）等库管字段以岩芯库台账为准。台账即便混入现场字段也不会覆盖现场值。
- **只在一侧的箱**：仅现场有则原样保留（台账缺失不删箱）；仅台账有则按台账补建。
- **两侧都动过**：对箱号、钻孔、深度区间等共有字段，现场与台账基于上一版结果改成不同值时，**两版都保留**在 `conflicts` 表，列出每个字段的基准值/现场值/台账值，由人在弹窗里一条条认；人工确认后的版本写入并成为新基准。
- **合并失败保住上一版**：落库放在单个 Dexie 事务中，任何一步抛错整体回滚，岩芯箱、分歧、状态全部维持上一版结果，失败台账也不会登记（可重送）。
- **失败后按侧重试**：先严格（strict）试算；一旦存在两侧同改挂起，自动用「现场侧优先 / 岩芯库侧优先」再跑一遍产出可入库版本，两版仍留痕，状态标为「自动消解·可改判」（自动消解不会在后续对账中短路，只有人工确认才沿用）。
- **台账幂等**：台账带 `batchId` 时按批次号去重，否则按内容指纹（FNV-1a）去重；同一份台账再送一次直接跳过，不会多出任何岩芯箱或台账登记记录。

台账 JSON 支持 `{ "batchId": "...", "boxes": [{ "boxNo", "shelfPos", "loanStatus", "loanTo", ... }] }` 或裸数组两种形态。合并引擎与服务层由 Vitest 覆盖（`npm test`，共 25 个用例，含事务回滚保住上一版、侧重试、幂等、人工认领沿用等场景）。
