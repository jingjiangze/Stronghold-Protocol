# 素材目录

## 公共回退素材（已入库）

`assets/public/` 包含原创、可随仓库分发的向量素材：球场场景回退背景，以及十种足球、六种比赛风格/携带物和八种职业的图标。它们不是官方游戏贴图，但可以让没有客户端资源的全新克隆显示一致的界面和对象标识。

入口清单：`assets/public/manifest.json`。图标位于 `assets/public/icons.svg`，以 SVG symbol 的方式按 ID 复用。

## 本机官方素材（不入库）

`assets/ui/` 与 `assets/chibi/` 专用于从自己安装的《明日方舟》PC 客户端提取的资源。它们被 `.gitignore` 排除；请勿把提取出的版权图片、音频、骨骼文件提交到公开仓库。

| 子目录 | 内容 | 客户端来源 |
|---|---|---|
| `ui/football/` | 足球 HUD 图片 | `ui/footballcup/battle/football_cup_battle_ui_plugin.ab` |
| `ui/style/` | 六种比赛风格图标 | `arts/ui/[uc]multiv3.ab` |
| `ui/scene/` | 场地地面贴图 | `arts/maps/multi_player/res.ab`、`activity/[uc]multiv3.ab` |
| `ui/audio/` | 得分/失分音效 | `audio/custom_se/act1multi.ab` 等 |
| `chibi/<operator-id>/` | Spine `.skel/.atlas/.png` | `chararts/char_<operator-id>.ab` |

### 提取

前置：Python 3.10+，客户端已安装。第一次执行会安装小型解包依赖：

```powershell
py -m pip install UnityPy lz4 Pillow
py tools/extract-assets.py --ab "C:\\Path\\To\\Arknights_Data\\StreamingAssets\\AB\\Windows"
py tools/import-operator-data.py --character-table "C:\\Path\\To\\Arknights_Data\\StreamingAssets\\gamedata\\excel\\character_table.json" --skill-table "C:\\Path\\To\\Arknights_Data\\StreamingAssets\\gamedata\\excel\\skill_table.json"
py tools/check-assets.py
```

提取器会把骨骼包的路径规范化为页面需要的 `/chibi/<operator-id>/`。`import-operator-data.py` 将本机干员属性、费用、阻挡和技能的SP字段导出到被 Git 忽略的 `assets/local/operators.generated.json`；页面优先读取此目录，然后回退到仓库内六名干员的示例数据。复杂技能效果根据本地 blackboard/描述推导，脚本会标注其推断性质；没有逐技能覆盖表验证之前，不应把所有技能行为称作百分百精确复刻。如果某个客户端版本中的骨骼/纹理命名变化，检查脚本会列出缺项，页面仍应使用公共回退素材而不是让单位消失。

`py tools/check-assets.py --require-official` 用于本机素材齐全后的严格校验，并检查本机生成的干员目录；`py tools/check-assets.py` 只要求公共资源完整。

## 版权与边界

官方游戏中的名称、美术、音频、模型、动画和提取出的游戏数据属于其各自权利人。本仓库只分发原创回退素材与提取工具，不分发提取后的官方资源。