Add-Type -AssemblyName System.Drawing
$assetPath = Join-Path $PSScriptRoot '..\assets'
[System.IO.Directory]::CreateDirectory($assetPath) | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(19, 23, 30))
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(164, 233, 197))
$points = [System.Drawing.Point[]]@([System.Drawing.Point]::new(38, 64), [System.Drawing.Point]::new(101, 64), [System.Drawing.Point]::new(120, 84), [System.Drawing.Point]::new(218, 84), [System.Drawing.Point]::new(218, 194), [System.Drawing.Point]::new(38, 194))
$graphics.FillPolygon($brush, $points)
$darkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(28, 55, 44))
$font = [System.Drawing.Font]::new('Segoe UI', 68, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('f', $font, $darkBrush, 67, 95)
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(28, 55, 44), 10)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($pen, 133, 125, 164, 156)
$graphics.DrawLine($pen, 164, 125, 133, 156)
$stream = [System.IO.MemoryStream]::new()
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $assetPath 'icon.png'), $png)
$file = [System.IO.File]::Create((Join-Path $assetPath 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png)
$writer.Dispose(); $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $brush.Dispose(); $darkBrush.Dispose(); $font.Dispose(); $pen.Dispose()
Write-Output 'Created assets/icon.ico and assets/icon.png'
