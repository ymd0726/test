import base64, os
A="assets/"
def b64(f, mime="image/png"):
    with open(A+f,"rb") as fh: return f"data:{mime};base64,"+base64.b64encode(fh.read()).decode()
emblem,plum,cloud,knot,wnav,wgold=[b64(x) for x in
    ["emblem.png","plum.png","cloud.png","knot.png","wave_navy.png","wave_gold.png"]]
washi=b64("washi.jpg","image/jpeg")

NAVY="#182741"; GOLD="#A87F41"
LAT="'EB Garamond',Georgia,serif"
MIN="'Noto Serif JP',serif"

html=f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="hz:slide-selector" content=".card">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
.card{{position:relative;width:825px;height:1365px;overflow:hidden;
  background-image:url({washi});background-size:cover;background-position:center;
  font-family:{LAT};}}
.t{{position:absolute;white-space:nowrap}}
.ctr{{width:100%;text-align:center;left:0}}
img{{position:absolute}}
.rule{{position:absolute;background:{GOLD}}}
</style></head><body>

<!-- ===== FRONT ===== -->
<div class="card" data-document-role="page" data-label="表面 / FRONT">
  <img src="{plum}"  style="left:-40px;top:-34px;width:322px;">
  <img src="{cloud}" style="left:642px;top:70px;width:212px;">
  <img src="{emblem}" style="left:225px;top:132px;width:374px;">

  <div class="t ctr" style="top:596px;font-family:{LAT};font-size:62px;font-weight:600;letter-spacing:1px;color:{NAVY};">belles&nbsp;Co.,Ltd.</div>
  <div class="t ctr" style="top:676px;font-family:{MIN};font-size:31px;font-weight:500;letter-spacing:13px;color:{NAVY};padding-left:13px;">株式会社ベルズ</div>
  <img src="{knot}" style="left:305px;top:728px;width:215px;">
  <div class="t ctr" style="top:824px;font-family:{MIN};font-size:23px;letter-spacing:15px;color:{NAVY};padding-left:15px;">代表</div>
  <div class="t ctr" style="top:856px;font-family:{MIN};font-size:60px;font-weight:500;letter-spacing:10px;color:{NAVY};padding-left:10px;">川口　裕市</div>
  <div class="t ctr" style="top:946px;font-family:{LAT};font-size:29px;letter-spacing:5px;color:{GOLD};">Kawaguchi&nbsp;Yuichi</div>

  <img src="{wnav}" style="left:0;top:1012px;width:825px;height:353px;">
</div>

<!-- ===== BACK ===== -->
<div class="card" data-document-role="page" data-label="裏面 / BACK">
  <img src="{cloud}" style="left:-22px;top:92px;width:210px;">
  <img src="{plum}"  style="left:566px;top:-42px;width:300px;transform:scaleX(-1);">

  <div class="t ctr" style="top:292px;font-family:{LAT};font-size:66px;font-weight:600;letter-spacing:1px;color:{NAVY};">belles&nbsp;Co.,Ltd.</div>
  <div class="t ctr" style="top:384px;font-family:{MIN};font-size:31px;font-weight:500;letter-spacing:13px;color:{NAVY};padding-left:13px;">株式会社ベルズ</div>
  <img src="{knot}" style="left:298px;top:438px;width:230px;">

  <div class="rule" style="left:80px;top:536px;width:2px;height:426px;"></div>

  <div class="t" style="left:108px;top:532px;font-family:{MIN};font-size:27px;line-height:1.42;color:{NAVY};">〒110-0016<br>東京都台東区台東四丁目31番1号<br>ALビル4F</div>
  <div class="t" style="left:108px;top:664px;font-family:{MIN};font-size:27px;line-height:1.42;color:{NAVY};">〒121-0832<br>東京都足立区古千谷本町2-25-31</div>

  <div class="t" style="left:108px;top:780px;font-family:{LAT};font-size:29px;line-height:1.66;color:{NAVY};">
   <span style="color:{GOLD};">Phone.</span>&nbsp;&nbsp;080-4406-1225<br>
   <span style="color:{GOLD};">Tel.</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;03-6824-2117<br>
   <span style="color:{GOLD};">Web.</span>&nbsp;&nbsp;&nbsp;&nbsp;www.belle-s.com<br>
   <span style="color:{GOLD};">E-mail.</span>&nbsp;adv@belle-s.com</div>

  <img src="{wgold}" style="left:0;top:1050px;width:825px;height:315px;">
</div>
</body></html>"""
open("card.html","w").write(html)
print("card.html", os.path.getsize("card.html")//1024,"KB")
