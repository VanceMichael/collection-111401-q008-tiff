# 航测资料范围出口

`/survey` 给出影像资源、像素尺度及默认领取窗口；窗口为左上闭、右下开的整数像素范围，坐标根据影像中的 PixelScale/Tiepoint 与目录尺度解释。目录 maxPixelSize 是接收方能接受的最大像素尺度。overview 的目录尺度较粗，不满足默认申请；不因两份演练文件尺寸相同而视为等价。

TIFF 是小端 classic TIFF，单波段 uint8、tiled、planar=1，支持未压缩和 Deflate；标签提供 tile offsets/counts、像素尺度和定位点。不要求支持其他 TIFF 编码，但不能静默误读。跨瓦片窗口须保留正确行列位置，0 是目录指定的无效值。

资源支持单范围 Range、ETag 和 If-Match；generation 改变文件版，mode=deflate 改变瓦片编码。412 表示旧版条件不成立，416 表示范围无效。下载字节数可由来源 state.transferred 核对，整文件 GET 仅供当前人工领取。

## 本地演练控制

`GET /_health` 返回服务健康状态；`GET /_audit` 仅返回请求路径、方法和体积，不记录凭据。`POST /_control` 接收 JSON，可调整 generation、mode、clock。控制端点只服务于本地演练，不是资料接口，也不是浏览器业务操作入口。每次重新启动服务都会恢复初始数据；生产接入时不部署此控制面。
