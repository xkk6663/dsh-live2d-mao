# phys_bounds.ps1 - 枚举真实显示器（含USB副屏）物理边界，供 Electron 桌宠窗口跨屏覆盖
# 输出: physL,physT,physR,physB,primaryPhysW  (物理像素，逗号分隔，单行)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiAware {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
'@
[DpiAware]::SetProcessDPIAware() | Out-Null

$left = [int]::MaxValue
$top = [int]::MaxValue
$right = [int]::MinValue
$bottom = [int]::MinValue
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($b.X -lt $left) { $left = $b.X }
    if ($b.Y -lt $top) { $top = $b.Y }
    if (($b.X + $b.Width) -gt $right) { $right = $b.X + $b.Width }
    if (($b.Y + $b.Height) -gt $bottom) { $bottom = $b.Y + $b.Height }
}
if ($right -eq [int]::MinValue) {
    $p = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    "$($p.X),$($p.Y),$($p.X + $p.Width),$($p.Y + $p.Height),$($p.Width)"
} else {
    $p = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    "$left,$top,$right,$bottom,$($p.Width)"
}
