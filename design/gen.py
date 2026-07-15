import base64, os
A="assets/"
def b64(f):
    with open(A+f,"rb") as fh: return "data:image/png;base64,"+base64.b64encode(fh.read()).decode()
emblem,plum,cloud,knot,wnav,wgold=[b64(x) for x in
    ["emblem.png","plum.png","cloud.png","knot.png","wave_navy.png","wave_gold.png"]]
CREAM="#F4ECDC"; NAVY="#1C2B4B"; GOLD="#B0873A"; GOLD2="#C9A24B"
SERIF="'Cormorant Garamond','Playfair Display','Times New Roman',Georgia,serif"
MIN="'Noto Serif JP','Yu Mincho','Hiragino Mincho ProN','IPAmjMincho','IPAMincho',serif"
def px(v): return f"{v}px"
html=f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="hz:slide-selector" content=".card">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
.card{{position:relative;width:825px;height:1365px;background:{CREAM};overflow:hidden;
  font-family:{SERIF};}}
.t{{position:absolute;white-space:nowrap;}}
.ctr{{width:100%;text-align:center;left:0;}}
img{{position:absolute;}}
</style></head><body>

<!-- ================= FRONT ================= -->
<div class="card" data-document-role="page" data-label="表面 / FRONT">
  <img src="{plum}"  style="left:-34px;top:-40px;width:212px;">
  <img src="{cloud}" style="left:596px;top:74px;width:192px;">
  <img src="{emblem}" style="left:249px;top:170px;width:328px;">

  <div class="t ctr" style="top:566px;font-family:{SERIF};font-size:58px;font-weight:600;letter-spacing:1px;color:{NAVY};">belles&nbsp;Co.,Ltd.</div>
  <div class="t ctr" style="top:648px;font-family:{MIN};font-size:30px;letter-spacing:10px;color:{NAVY};">株式会社ベルズ</div>
  <img src="{knot}" style="left:325px;top:706px;width:175px;">
  <div class="t ctr" style="top:784px;font-family:{MIN};font-size:23px;letter-spacing:14px;color:{NAVY};">代表</div>
  <div class="t ctr" style="top:812px;font-family:{MIN};font-size:62px;letter-spacing:6px;color:{NAVY};">川口　裕市</div>
  <div class="t ctr" style="top:902px;font-family:{SERIF};font-size:28px;letter-spacing:5px;color:{GOLD};">Kawaguchi&nbsp;Yuichi</div>

  <img src="{wnav}" style="left:0;top:1012px;width:825px;height:353px;">
</div>

<!-- ================= BACK ================= -->
<div class="card" data-document-role="page" data-label="裏面 / BACK">
  <img src="{plum}"  style="left:581px;top:-24px;width:258px;transform:scaleX(-1);">
  <img src="{cloud}" style="left:40px;top:92px;width:196px;">

  <div class="t ctr" style="top:236px;font-family:{SERIF};font-size:54px;font-weight:600;letter-spacing:1px;color:{NAVY};">belles&nbsp;Co.,Ltd.</div>
  <div class="t ctr" style="top:314px;font-family:{MIN};font-size:28px;letter-spacing:9px;color:{NAVY};">株式会社ベルズ</div>
  <img src="{knot}" style="left:333px;top:372px;width:160px;">

  <div class="t" style="left:150px;top:452px;font-family:{MIN};font-size:27px;line-height:1.5;color:{NAVY};">〒110-0016<br>東京都台東区台東四丁目31番1号<br>ALビル4F</div>
  <div class="t" style="left:150px;top:604px;font-family:{MIN};font-size:27px;line-height:1.5;color:{NAVY};">〒121-0832<br>東京都足立区古千谷本町2-25-31</div>

  <div class="t" style="left:150px;top:724px;font-family:{SERIF};font-size:28px;line-height:1.62;color:{NAVY};">
   <span style="color:{GOLD};">Phone.</span>&nbsp;&nbsp;080-4406-1225<br>
   <span style="color:{GOLD};">Tel.</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;03-6824-2117<br>
   <span style="color:{GOLD};">Web.</span>&nbsp;&nbsp;&nbsp;&nbsp;www.belle-s.com<br>
   <span style="color:{GOLD};">E-mail.</span>&nbsp;adv@belle-s.com</div>

  <img src="{wgold}" style="left:0;top:1105px;width:825px;height:260px;">
</div>
</body></html>"""
open("card.html","w").write(html)
print("card.html", os.path.getsize("card.html")//1024,"KB")
