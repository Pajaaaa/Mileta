#!/usr/bin/env python3
"""Generátor reálného okolí křižovatky Mileta pro hru (buildings.js).

Vstupy:
  map.osm   – výřez OSM (api.openstreetmap.org/api/0.6/map?bbox=15.8255,50.1970,15.8395,50.2053)
  orto.jpg  – volitelně ortofoto ČÚZK téhož výřezu (WMS ORTOFOTO, EPSG:4326, 2500×2310):
              z něj se berou skutečné barvy střech a rozmístění stromů

Použití:  python3 tools/gen-okoli.py map.osm [orto.jpg [ladici-nahled-stromu.jpg]] > buildings.js

Stažení vstupů:
  curl -o map.osm 'https://api.openstreetmap.org/api/0.6/map?bbox=15.8255,50.1970,15.8395,50.2053'
  curl -o orto.jpg 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=0&STYLES=&SRS=EPSG:4326&BBOX=15.8255,50.1970,15.8395,50.2053&WIDTH=2500&HEIGHT=2310&FORMAT=image/jpeg'
Po přegenerování zvednout ?v= u skriptů v index.html.

Převod souřadnic: skutečná křižovatka není pravoúhlý kříž (Hradecká −11°,
Sokolská +4°/+8°, Zborovská −10° proti herním osám) a ramena se dál stáčejí.
Plochy a čáry se proto převádějí úhlově: vzdálenost od středu zůstává a úhel
mezi dvěma sousedními rameny se rovnoměrně přepočte na 90°, takže skutečná
ramena padnou přesně na herní osy a vše zůstane na správné straně ulice.
Budovy, parkoviště a hřiště se nepřevádějí bod po bodu (zkosily by se): umístí
se těžištěm jako tuhé těleso, natočí podle okolí a dorovnají přesně do os.
Koridor silnice (skutečných 14 m od osy) se roztahuje na herních 170 px.
"""
import sys, math, json, random
import xml.etree.ElementTree as ET

LAT0, LON0 = 50.201147, 15.832446          # střed křižovatky (průměr uzlů semaforů)
FRAME_ROT = math.radians(5.14)              # pracovní natočení rámu
MLAT = 111320.0
MLON = 111320.0 * math.cos(math.radians(LAT0))
PXM = 4.5                                   # px na metr mimo koridor
ROAD_M, ROAD_PX = 14.0, 170.0               # polovina koridoru: skutečnost → hra
OFF = ROAD_PX - ROAD_M * PXM
EXT = 1640                                  # vykreslovaný rozsah ±px
ORTO_BBOX = (15.8255, 50.1970, 15.8395, 50.2053)

# směr ramen (stupně od herního „nahoru“, po směru hodin) podle vzdálenosti od středu [m]
ARMS = [
    [(0, -10.5), (100, -10.5), (175, -12.4), (999, -12.6)],                    # 0 Hradecká
    [(0, 93.8), (200, 93.8), (275, 90.4), (325, 88.6), (380, 86.3), (999, 86.3)],  # 1 Sokolská V
    [(0, 170.2), (230, 170.8), (275, 175.0), (325, 177.7), (380, 180.0), (999, 180.0)],  # 2 Zborovská
    [(0, 277.8), (999, 277.8)],                                                # 3 Sokolská Z (FN)
]
GAX = [(0, -1), (1, 0), (0, 1), (-1, 0)]


def frame(lat, lon):
    e, n = (lon - LON0) * MLON, (lat - LAT0) * MLAT
    c, s = math.cos(FRAME_ROT), math.sin(FRAME_ROT)
    return e * c - n * s, -(e * s + n * c)


def unframe(x, y):
    yu = -y
    c, s = math.cos(FRAME_ROT), math.sin(FRAME_ROT)
    e, n = x * c + yu * s, -x * s + yu * c
    return LAT0 + n / MLAT, LON0 + e / MLON


def arm_bearing(k, r):
    kn = ARMS[k]
    for (r0, b0), (r1, b1) in zip(kn, kn[1:]):
        if r <= r1:
            return b0 + (b1 - b0) * (r - r0) / (r1 - r0)
    return kn[-1][1]


def quadrant(x, y):
    """→ (k, t): kvadrant mezi rameny k a k+1 a poloha v něm 0..1 (podle úhlu)."""
    r = math.hypot(x, y)
    if r < 1e-6:
        return 0, 0.0
    phi = math.degrees(math.atan2(x, -y))
    th = [arm_bearing(k, r) for k in range(4)]
    for k in range(4):
        span = (th[(k + 1) % 4] - th[k]) % 360
        d = (phi - th[k]) % 360
        if d <= span:
            break
    return k, d / span


def warp(x, y):
    """Skutečné metry → „herní“ metry: vzdálenost od středu zůstává, úhel mezi
    sousedními rameny se rovnoměrně roztáhne/stlačí na 90° (ramena padnou na osy)."""
    k, t = quadrant(x, y)
    r = math.hypot(x, y)
    a = math.radians(90 * k + 90 * t)
    return r * math.sin(a), -r * math.cos(a)


def local_rotation(x, y):
    """Stočení okolí v daném místě [°] — plynule mezi stočením obou ramen kvadrantu."""
    k, t = quadrant(x, y)
    r = math.hypot(x, y)
    k1 = (k + 1) % 4
    d0 = (90 * k - arm_bearing(k, r) + 180) % 360 - 180
    d1 = (90 * k1 - arm_bearing(k1, r) + 180) % 360 - 180
    return d0 + (d1 - d0) * t


def place_group(rings, min_px=180, limit=95, snap=25.0):
    """Umístí skupinu půdorysů jako jedno tuhé těleso: společné těžiště převodem,
    natočení podle okolí a dorovnání převládajícího směru hran přesně do herních os.
    Vzájemná poloha půdorysů ve skupině se nemění. Vrací seznam px obrysů nebo None."""
    A = sx_ = sy_ = 0.0
    for ring in rings:
        a, x, y = area_centroid(ring)
        A += a; sx_ += a * x; sy_ += a * y
    cx, cy = sx_ / A, sy_ / A
    d = math.radians(local_rotation(cx, cy))
    c, s_ = math.cos(d), math.sin(d)
    locs = [[((x - cx) * c - (y - cy) * s_, (x - cx) * s_ + (y - cy) * c) for x, y in ring] for ring in rings]
    sx4 = cx4 = 0.0
    for loc in locs:
        for (x0, y0), (x1, y1) in zip(loc, loc[1:] + loc[:1]):
            L = math.hypot(x1 - x0, y1 - y0)
            a = math.atan2(y1 - y0, x1 - x0)
            sx4 += L * math.sin(4 * a); cx4 += L * math.cos(4 * a)
    dev = math.atan2(sx4, cx4) / 4
    if abs(math.degrees(dev)) <= snap:
        c, s_ = math.cos(-dev), math.sin(-dev)
        locs = [[(x * c - y * s_, x * s_ + y * c) for x, y in loc] for loc in locs]
    gx, gy = warp(cx, cy)
    X, Y = inflate(gx), inflate(gy)
    out = [[(X + x * PXM, Y + y * PXM) for x, y in loc] for loc in locs]
    sx = 1 if gx >= 0 else -1; sy = 1 if gy >= 0 else -1
    dx = max(0.0, min_px - min(p[0] * sx for pts in out for p in pts))
    dy = max(0.0, min_px - min(p[1] * sy for pts in out for p in pts))
    if dx > limit or dy > limit:
        return None
    return [[(x + dx * sx, y + dy * sy) for x, y in pts] for pts in out]


def place_rigid(ring, min_px=180, limit=95, snap=25.0):
    r = place_group([ring], min_px, limit, snap)
    if not r or not any(abs(x) <= EXT and abs(y) <= EXT for x, y in r[0]):
        return None
    return r[0]


def ring_gap(a, b):
    """Nejmenší vzdálenost dvou obrysů [m] (0, když se překrývají)."""
    if pip(a[0][0], a[0][1], b) or pip(b[0][0], b[0][1], a):
        return 0.0
    best = 1e18
    for p, q in ((a, b), (b, a)):
        for i in range(len(q)):
            for pt in p:
                best = min(best, seg_dist2(pt[0], pt[1], q[i], q[(i + 1) % len(q)]))
    return math.sqrt(best)


def cluster(buildings, gap=9.0):
    """Sousedící budovy (blíž než gap metrů) do skupin — umísťují se společně."""
    n = len(buildings)
    par = list(range(n))

    def find(i):
        while par[i] != i:
            par[i] = par[par[i]]; i = par[i]
        return i
    bb = [bbox(b['q']) for b in buildings]
    for i in range(n):
        for j in range(i + 1, n):
            if bb[i][0] - gap > bb[j][2] or bb[j][0] - gap > bb[i][2] or bb[i][1] - gap > bb[j][3] or bb[j][1] - gap > bb[i][3]:
                continue
            if find(i) != find(j) and ring_gap(buildings[i]['q'], buildings[j]['q']) < gap:
                par[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(buildings[i])
    return list(groups.values())


def inflate(u):
    if abs(u) <= ROAD_M:
        return u * ROAD_PX / ROAD_M
    return math.copysign(abs(u) * PXM + OFF, u)


def px(x, y):
    gx, gy = warp(x, y)
    return inflate(gx), inflate(gy)


def corridor(x, y, half=ROAD_M):
    gx, gy = warp(x, y)
    return min(abs(gx), abs(gy)) < half


# ---------- geometrie ----------
def densify(pts, step):
    out = [pts[0]]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.ceil(math.hypot(x1 - x0, y1 - y0) / step)))
        for i in range(1, n + 1):
            out.append((x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n))
    return out


def simplify(pts, eps):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    st = [(0, len(pts) - 1)]
    while st:
        i, j = st.pop()
        (x0, y0), (x1, y1) = pts[i], pts[j]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1e-9
        bd, bi = 0, -1
        for m in range(i + 1, j):
            d = abs((pts[m][0] - x0) * dy - (pts[m][1] - y0) * dx) / L
            if d > bd:
                bd, bi = d, m
        if bd > eps:
            keep[bi] = True
            st.append((i, bi)); st.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(pts, eps):
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 4:
        return pts
    # rozdělit v nejvzdálenějším bodě, ať DP nezdegeneruje uzavřený tvar
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a = simplify(pts[:far + 1], eps)
    b = simplify(pts[far:] + [pts[0]], eps)
    return a[:-1] + b[:-1]


def clip_rect(poly, lim):
    """Sutherland–Hodgman na čtverec ±lim."""
    def cut(pts, inside, inter):
        out = []
        for i in range(len(pts)):
            p, q = pts[i - 1], pts[i]
            if inside(q):
                if not inside(p):
                    out.append(inter(p, q))
                out.append(q)
            elif inside(p):
                out.append(inter(p, q))
        return out
    for ax, sg in ((0, 1), (0, -1), (1, 1), (1, -1)):
        if not poly:
            break
        def inside(p, ax=ax, sg=sg): return sg * p[ax] <= lim
        def inter(p, q, ax=ax, sg=sg):
            t = (sg * lim - p[ax]) / (q[ax] - p[ax])
            return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
        poly = cut(poly, inside, inter)
    return poly


def area_centroid(pts):
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        c = x0 * y1 - x1 * y0
        a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
    if abs(a) < 1e-9:
        return 0.0, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    return abs(a) / 2, cx / (3 * a), cy / (3 * a)


def pip(x, y, poly):
    ins = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            ins = not ins
        j = i
    return ins


def bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def seg_dist2(px_, py_, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((px_ - a[0]) * dx + (py_ - a[1]) * dy) / L2))
    ex, ey = a[0] + dx * t - px_, a[1] + dy * t - py_
    return ex * ex + ey * ey


def runs(pts, keep_fn):
    """Rozdělí lomenou čáru na úseky, kde keep_fn platí; hranice dohledá půlením."""
    out, cur = [], []
    prev, pk = None, False
    for p in pts:
        k = keep_fn(p)
        if prev is not None and k != pk:
            a, b = (prev, p) if pk else (p, prev)   # a = uvnitř povoleného
            for _ in range(10):
                m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                if keep_fn(m): a = m
                else: b = m
            if pk:
                cur.append(a); out.append((cur, 'cut')); cur = []
            else:
                cur = [a]
        if k:
            cur.append(p)
        prev, pk = p, k
    if len(cur) > 1:
        out.append((cur, 'end'))
    return [(c, why) for c, why in out if len(c) > 1]


def ri(pts):
    out = []
    for x, y in pts:
        q = [int(round(x)), int(round(y))]
        if not out or out[-1] != q:
            out.append(q)
    return out


# ---------- načtení OSM ----------
def load(path):
    root = ET.parse(path).getroot()
    nodes, ntags = {}, {}
    for n in root.iter('node'):
        nodes[n.get('id')] = frame(float(n.get('lat')), float(n.get('lon')))
        t = {x.get('k'): x.get('v') for x in n.findall('tag')}
        if t:
            ntags[n.get('id')] = t
    ways = {}
    for w in root.iter('way'):
        refs = [nd.get('ref') for nd in w.findall('nd')]
        if all(r in nodes for r in refs) and len(refs) > 1:
            ways[w.get('id')] = ([nodes[r] for r in refs], {x.get('k'): x.get('v') for x in w.findall('tag')}, refs)
    rels = []
    for r in root.iter('relation'):
        t = {x.get('k'): x.get('v') for x in r.findall('tag')}
        if t.get('type') != 'multipolygon':
            continue
        outers = [m.get('ref') for m in r.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '')]
        rels.append((t, outers))
    return nodes, ntags, ways, rels


def stitch(ways, ids):
    """Poskládá vnější okruhy multipolygonu z členských cest."""
    segs = [list(ways[i][2]) for i in ids if i in ways]
    coords = {}
    for i in ids:
        if i in ways:
            for r, p in zip(ways[i][2], ways[i][0]):
                coords[r] = p
    rings = []
    while segs:
        cur = segs.pop()
        while cur[0] != cur[-1]:
            for i, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]; break
                if s[-1] == cur[-1]: cur += s[-2::-1]; break
            else:
                break
            segs.pop(i)
        if cur[0] == cur[-1] and len(cur) > 3:
            rings.append([coords[r] for r in cur])
    return rings


def main():
    osm = sys.argv[1]
    orto = sys.argv[2] if len(sys.argv) > 2 else None
    dbg = sys.argv[3] if len(sys.argv) > 3 else None
    nodes, ntags, ways, rels = load(osm)
    random.seed(20261121)

    im = None
    if orto:
        from PIL import Image
        im = Image.open(orto).convert('RGB')
        IW, IH = im.size
        ipx = im.load()

    def orto_xy(x, y):
        lat, lon = unframe(x, y)
        return ((lon - ORTO_BBOX[0]) / (ORTO_BBOX[2] - ORTO_BBOX[0]) * IW,
                (ORTO_BBOX[3] - lat) / (ORTO_BBOX[3] - ORTO_BBOX[1]) * IH)

    # --- plochy: uzavřené cesty + multipolygony
    polys = []   # (tags, ring v metrech)
    for wid, (pts, t, refs) in ways.items():
        if refs[0] == refs[-1] and len(pts) > 3:
            polys.append((t, pts[:-1]))
    for t, outers in rels:
        for ring in stitch(ways, outers):
            polys.append((t, ring[:-1]))

    def in_ext(mapped):
        return any(abs(x) <= EXT and abs(y) <= EXT for x, y in mapped)

    def map_poly(ring, eps=1.5):
        m = [px(x, y) for x, y in densify(ring + ring[:1], 3.0)[:-1]]
        if not in_ext(m):
            return None
        m = clip_rect(m, EXT + 60)
        if len(m) < 3:
            return None
        m = ri(simplify_ring(m, eps))
        return m if len(m) >= 3 else None

    env = {k: [] for k in ('grass', 'park', 'forest', 'water', 'pitch', 'play', 'paved', 'dirt',
                           'roads', 'stubs', 'paths', 'tracks', 'streams', 'fences', 'trees', 'labels')}
    parking, buildings = [], []
    real = {'bld': [], 'park': [], 'pitch': [], 'water': [], 'road': [], 'forest': [], 'dirt': []}   # pro vylučování stromů (metry)
    named = []

    GRASS = {'grass', 'meadow', 'village_green', 'flowerbed', 'recreation_ground', 'greenfield'}
    for t, ring in polys:
        kind = None
        lu, nat, lei, am = t.get('landuse'), t.get('natural'), t.get('leisure'), t.get('amenity')
        if 'building' in t and t['building'] != 'no':
            kind = 'building'
        elif am == 'parking' and t.get('parking') not in ('underground', 'multi-storey'):
            kind = 'parking'
        elif lei in ('pitch',):
            kind = 'pitch'
        elif lei == 'playground':
            kind = 'play'
        elif nat == 'water' or t.get('waterway') == 'riverbank':
            kind = 'water'
        elif lu == 'forest' or nat in ('wood', 'scrub'):
            kind = 'forest'
        elif lei in ('park', 'garden'):
            kind = 'park'
        elif lu in GRASS or nat == 'grassland':
            kind = 'grass'
        elif lu in ('construction', 'brownfield'):
            kind = 'dirt'
        elif t.get('highway') == 'pedestrian' or (t.get('highway') in ('footway',) and t.get('area') == 'yes') or t.get('place') == 'square':
            kind = 'paved'
        if 'name' in t and (am in ('hospital', 'university', 'fire_station', 'fuel', 'college', 'library') or
                            lei in ('stadium', 'sports_centre', 'park', 'garden', 'track') or t.get('shop') == 'supermarket' or
                            t.get('building') == 'construction'):
            vis = clip_rect([px(x, y) for x, y in densify(ring + ring[:1], 3.0)[:-1]], 1380)
            if len(vis) >= 3:
                va, vx, vy = area_centroid(vis)
                named.append((t['name'], (vx, vy), am or lei or t.get('shop') or t.get('building'), va))
        if kind is None:
            continue
        if kind == 'building':
            b = make_building(t, ring, im and (ipx, orto_xy, IW, IH))
            if b:
                buildings.append(b)
                real['bld'].append((bbox(ring), ring))
            continue
        if kind in ('parking', 'pitch', 'play'):
            m = place_rigid(ring, 174)
            m = ri(m) if m else None
        else:
            m = map_poly(ring)
        if not m:
            continue
        if kind == 'parking':
            parking.append(m); real['park'].append((bbox(ring), ring))
        elif kind == 'pitch':
            sport, surf = t.get('sport', ''), t.get('surface', '')
            c = 'c' if (surf in ('clay',) or (sport == 'tennis' and surf in ('', 'clay'))) else \
                'g' if (surf in ('grass', 'artificial_turf') or sport in ('soccer', 'football', 'rugby') and surf == '') else 'h'
            env['pitch'].append({'p': m, 'c': c, 's': sport[:10]})
            real['pitch'].append((bbox(ring), ring))
        elif kind == 'water':
            env['water'].append(m); real['water'].append((bbox(ring), ring))
        else:
            env[kind].append(m)
            if kind in ('forest', 'dirt'):
                real[kind].append((bbox(ring), ring))

    # --- čáry
    ROADW = {'tertiary': 34, 'secondary': 34, 'unclassified': 28, 'residential': 28, 'living_street': 24, 'service': 18}
    PATHS = {'footway': 'f', 'path': 'f', 'pedestrian': 'p', 'cycleway': 'c', 'steps': 's', 'track': 't'}
    for wid, (pts, t, refs) in ways.items():
        hw = t.get('highway')
        closed_area = refs[0] == refs[-1] and (t.get('area') == 'yes')
        if t.get('tunnel') in ('yes', 'culvert') or t.get('indoor') == 'yes' or t.get('covered') == 'yes':
            continue
        try:
            if int(t.get('layer', '0')) < 0:
                continue
        except ValueError:
            pass
        if hw in ROADW or hw in ('primary', 'primary_link', 'tertiary_link', 'secondary_link'):
            d = densify(pts, 1.5)
            frac = sum(1 for p in d if corridor(p[0], p[1], 16.0)) / len(d)
            rmax = max(math.hypot(*p) for p in d)
            if hw.startswith('primary') or frac > 0.6 or (hw.endswith('_link') and rmax < 130):
                continue    # hlavní ramena a jejich bypassy kreslí hra sama
            w = ROADW.get(hw, 22)
            if hw == 'service':
                inpark = sum(1 for p in d if any(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 and pip(p[0], p[1], rg)
                                                 for (x0, y0, x1, y1), rg in real['park'])) / len(d)
                if inpark > 0.5 or t.get('service') == 'parking_aisle':
                    continue
            if t.get('service') == 'driveway':
                w = 14
            hw_m = w / PXM / 2 + 0.5
            for seg in zip(pts, pts[1:]):
                real['road'].append((seg, hw_m))
            for run, why in runs(d, lambda p: not corridor(p[0], p[1])):
                m = [px(x, y) for x, y in run]
                if not in_ext(m):
                    continue
                env['roads'].append({'p': ri(simplify(m, 1.2)), 'w': w})
            # zaústění do hlavní silnice: kde cesta vstoupí do koridoru a dojde až k ose
            g = [warp(x, y) for x, y in d]
            for i in range(1, len(g)):
                for a, b in ((g[i - 1], g[i]), (g[i], g[i - 1])):
                    for ax in (0, 1):
                        if abs(a[ax]) >= ROAD_M > abs(b[ax]) and abs(a[1 - ax]) > 50:
                            # jde dál k ose? (někde na této cestě v okolí je |g| < 7 m)
                            near = any(abs(q[ax]) < 7 and abs(q[1 - ax] - b[1 - ax]) < 25 for q in g[max(0, i - 40):i + 40])
                            if not near:
                                continue
                            wx = math.copysign(ROAD_PX, a[ax]); wa = inflate(b[1 - ax])
                            world = (wx, wa) if ax == 0 else (wa, wx)
                            k = (0 if world[1] < 0 else 2) if ax == 0 else (1 if world[0] > 0 else 3)
                            lx, ly = inv_arm(k, *world)
                            if ly < -330 and abs(ly) < EXT:
                                env['stubs'].append({'k': k, 's': 1 if lx > 0 else -1, 'y': int(round(ly)), 'w': max(w, 22)})
        elif hw in PATHS and not closed_area:
            d = densify(pts, 1.5)

            def keep(p, d=d):
                gx, gy = warp(p[0], p[1])
                return min(abs(gx), abs(gy)) >= 13.4
            # chodník souběžný s hlavní silnicí těsně u ní vynechat (hra má vlastní)
            g = [warp(x, y) for x, y in d]
            par = sum(1 for q in g if min(abs(q[0]), abs(q[1])) < 20) / len(g)
            if par > 0.7 and len(d) * 1.5 > 12:
                continue
            for run, why in runs(d, keep):
                m = [px(x, y) for x, y in run]
                if not in_ext(m):
                    continue
                s = ri(simplify(m, 1.2))
                if len(s) > 1:
                    env['paths'].append({'p': s, 't': PATHS[hw]})
        elif t.get('leisure') == 'track':
            m = [px(x, y) for x, y in densify(pts, 2.0)]
            if in_ext(m):
                env['tracks'].append({'p': ri(simplify(m, 1.0)), 'w': 30 if refs[0] == refs[-1] else 10})
                for seg in zip(pts, pts[1:]):
                    real['road'].append((seg, 4.5))
        elif t.get('waterway') in ('river', 'stream', 'canal', 'ditch'):
            w = {'river': 90, 'canal': 26, 'stream': 9, 'ditch': 6}[t['waterway']]
            for run, why in runs(densify(pts, 1.5), lambda p: not corridor(p[0], p[1])):
                m = [px(x, y) for x, y in run]
                if in_ext(m):
                    env['streams'].append({'p': ri(simplify(m, 1.2)), 'w': w})
            for seg in zip(pts, pts[1:]):
                real['road'].append((seg, w / PXM / 2 + 1))
        elif t.get('barrier') in ('fence', 'wall', 'retaining_wall', 'city_wall', 'hedge'):
            for run, why in runs(densify(pts, 1.5), lambda p: not corridor(p[0], p[1], 14.6)):
                m = [px(x, y) for x, y in run]
                if in_ext(m):
                    s = ri(simplify(m, 1.2))
                    if len(s) > 1:
                        env['fences'].append({'p': s, 't': 'h' if t['barrier'] == 'hedge' else 'f'})

    # --- budovy: vytlačit z koridoru, zahodit ty, které stojí v herní silnici
    kept = []
    for grp in cluster(buildings):
        placed = place_group([b['q'] for b in grp])
        if placed is None and len(grp) > 1:        # skupina se nevejde → zkusit po jedné
            placed = [(place_group([b['q']]) or [None])[0] for b in grp]
        for b, pts in zip(grp, placed or [None] * len(grp)):
            r = place_building(b, pts)
            if r:
                kept.append(r)
    buildings = kept

    # --- stromy z ortofota (tmavě zelené/zrnité koruny) + stromořadí z OSM
    trees = []
    patch = None
    if im:
        step = 7.5

        def patch(x, y):
            ox, oy = orto_xy(x, y)
            ox, oy = int(ox), int(oy)
            if ox < 4 or oy < 4 or ox >= IW - 4 or oy >= IH - 4:
                return None
            vals = [ipx[ox + i, oy + j] for i in range(-3, 4, 2) for j in range(-3, 4, 2)]
            n = len(vals)
            r = sum(v[0] for v in vals) / n; g = sum(v[1] for v in vals) / n; bl = sum(v[2] for v in vals) / n
            lum = [(v[0] + v[1] + v[2]) / 3 for v in vals]
            mu = sum(lum) / n
            sd = math.sqrt(sum((l - mu) ** 2 for l in lum) / n)
            return r, g, bl, mu, sd
        y = -620.0
        while y < 620:
            x = -620.0
            while x < 620:
                tx, ty = x + random.uniform(-2.6, 2.6), y + random.uniform(-2.6, 2.6)
                x += step
                pa = patch(tx, ty)
                if not pa:
                    continue
                r, g, bl, mu, sd = pa
                green = g - r > 9 and g - bl > 6
                if not (green and (mu < 70 or (mu < 86 and sd > 10.5))):
                    continue
                trees.append((tx, ty))
            y += step
    for (x0, y0, x1, y1), ring in real['forest']:
        yy = y0
        while yy < y1:
            xx = x0
            while xx < x1:
                tx, ty = xx + random.uniform(-2.4, 2.4), yy + random.uniform(-2.4, 2.4)
                xx += 7.0
                if not pip(tx, ty, ring):
                    continue
                if im:
                    pa = patch(tx, ty)
                    if pa and not (pa[1] > pa[0] and pa[1] > pa[2] and pa[3] < 105):
                        continue        # mýtina / zpevněná plocha uvnitř lesa
                trees.append((tx, ty))
            yy += 7.0
    for wid, (pts, t, refs) in ways.items():
        if t.get('natural') == 'tree_row':
            for p in densify(pts, 8.0):
                trees.append(p)
    for nid, t in ntags.items():
        if t.get('natural') == 'tree':
            trees.append(nodes[nid])

    def blocked(x, y):
        if corridor(x, y, 15.6):
            return True
        for key, margin in (('bld', 1.5), ('park', 0), ('pitch', 0), ('water', 0), ('dirt', 0)):
            for (x0, y0, x1, y1), ring in real[key]:
                if x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin and pip(x, y, ring):
                    return True
        for (a, b), hw_m in real['road']:
            if min(a[0], b[0]) - hw_m <= x <= max(a[0], b[0]) + hw_m and min(a[1], b[1]) - hw_m <= y <= max(a[1], b[1]) + hw_m:
                if seg_dist2(x, y, a, b) < hw_m * hw_m:
                    return True
        return False
    bpx = [(bbox(q), q) for q in [b['p'] for b in buildings] + parking + [pp['p'] for pp in env['pitch']] + env['play']]
    tout, taken = [], {}
    dbg_pts = []
    for x, y in trees:
        if blocked(x, y):
            continue
        X, Y = px(x, y)
        if abs(X) > EXT or abs(Y) > EXT:
            continue
        if any(x0 - 8 <= X <= x1 + 8 and y0 - 8 <= Y <= y1 + 8 and pip(X, Y, ring) for (x0, y0, x1, y1), ring in bpx):
            continue
        cell = (int(X // 16), int(Y // 16))
        if cell in taken:
            continue
        taken[cell] = 1
        tout += [int(round(X)), int(round(Y))]
        dbg_pts.append((x, y))
    env['trees'] = tout

    if dbg and im:
        from PIL import ImageDraw
        d = ImageDraw.Draw(im)
        for x, y in dbg_pts:
            ox, oy = orto_xy(x, y)
            d.ellipse((ox - 5, oy - 5, ox + 5, oy + 5), outline=(255, 40, 200), width=2)
        im.resize((IW // 2, IH // 2)).save(dbg, quality=80)

    # --- popisky významných míst
    LABELS = {
        'Fakultní nemocnice Hradec Králové': 'Fakultní nemocnice',
        'Universita Hradec Králové': 'Univerzita Hradec Králové',
        'Stadion HZS Královéhradeckého kraje': 'Stadion HZS',
        'HZS Královéhradeckého kraje - požární stanice Hradec Králové': 'Hasiči',
        'Botanická zahrada léčivých rostlin': 'Botanická zahrada',
        'Studijní a vědecká knihovna v Hradci Králové': 'Vědecká knihovna',
        'Kaufland': 'Kaufland (stavba)',
        'Univerzita Karlova': 'Univerzita Karlova',
    }
    seen = set()
    for name, (X, Y), kind, va in sorted(named, key=lambda n: -n[3]):
        print('  named:', name, int(X), int(Y), kind, int(va), file=sys.stderr)
        if name in LABELS and name not in seen and va > 40000:
            seen.add(name)
            env['labels'].append({'x': int(X), 'y': int(Y), 't': LABELS[name]})

    for b in buildings:
        b['p'] = ri(b['p'])
        for k in ('q', 'm', 'cm'):
            b.pop(k, None)
    env['roads'].sort(key=lambda r: -r['w'])
    # zaústění: sloučit blízké duplicity (dvoupruhové cesty mapované dvakrát)
    st = []
    for s in sorted(env['stubs'], key=lambda s: (s['k'], s['s'], s['y'])):
        if st and st[-1]['k'] == s['k'] and st[-1]['s'] == s['s'] and abs(st[-1]['y'] - s['y']) < 70:
            a = st[-1]
            lo = min(a['y'] - a['w'] / 2, s['y'] - s['w'] / 2); hi = max(a['y'] + a['w'] / 2, s['y'] + s['w'] / 2)
            a['y'] = int(round((lo + hi) / 2)); a['w'] = int(round(hi - lo))
            continue
        st.append(s)
    env['stubs'] = st

    print('  budov %d, parkovišť %d, ' % (len(buildings), len(parking)) +
          ', '.join('%s %d' % (k, len(v) // 2 if k == 'trees' else len(v)) for k, v in env.items()), file=sys.stderr)
    js = lambda o: json.dumps(o, ensure_ascii=False, separators=(',', ':'))
    print('// Reálné okolí křižovatky Mileta — generováno tools/gen-okoli.py, měřítko %.1f px/m.' % PXM)
    print('// Mapová data © přispěvatelé OpenStreetMap (ODbL); barvy střech a stromy podle Ortofota ČR © ČÚZK (CC BY 4.0).')
    print('window.REAL_BUILDINGS = %s;' % js(buildings))
    print('window.REAL_PARKING = %s;' % js(parking))
    print('window.REAL_ENV = %s;' % js(env))


def inv_arm(k, x, y):
    """Světové px → lokální rám ramene k (inverze armXform ve hře)."""
    k &= 3
    if k == 0: return x, y
    if k == 1: return y, -x
    if k == 2: return -x, -y
    return -y, x


LEVELS = {'house': 2, 'detached': 2, 'semidetached_house': 2, 'terrace': 2, 'garage': 1, 'garages': 1,
          'shed': 1, 'hut': 1, 'roof': 1, 'carport': 1, 'kiosk': 1, 'service': 1, 'apartments': 5,
          'residential': 4, 'dormitory': 5, 'hospital': 4, 'university': 4, 'school': 3, 'retail': 1,
          'commercial': 3, 'industrial': 2, 'warehouse': 1}


def make_building(t, ring, orto):
    area, cx, cy = area_centroid(ring)
    if area < 12:
        return None
    X, Y = px(cx, cy)
    if abs(X) > EXT + 150 or abs(Y) > EXT + 150:
        return None
    typ = t.get('building', 'yes')
    if t.get('amenity') == 'fuel' or typ == 'roof':
        typ = 'roof'
    try:
        lv = int(float(t.get('building:levels', '')))
    except ValueError:
        lv = LEVELS.get(typ, 2)
    shape = t.get('roof:shape', '')
    pitched = area < 420 and lv <= 3 and (
        shape in ('gabled', 'hipped', 'half-hipped', 'pitched', 'gambrel', 'mansard', 'pyramidal') or
        (shape == '' and typ in ('house', 'detached', 'semidetached_house', 'terrace', 'residential', 'yes') and area < 260))
    b = {'q': ring, 'm': (cx, cy), 'l': max(1, min(lv, 14)), 't': typ, 'r': 'p' if pitched else 'f'}
    if orto and typ != 'construction':
        ipx, orto_xy, IW, IH = orto
        poly = [orto_xy(x, y) for x, y in ring]
        x0, y0, x1, y1 = bbox(poly)
        ocx, ocy = orto_xy(cx, cy)
        # vzorky uvnitř půdorysu, stažené ke středu (mimo okraje a stíny u atiky)
        vals = []
        n = 0
        yy = y0
        stepo = max(1.0, (y1 - y0) / 24)
        stepx = max(1.0, (x1 - x0) / 24)
        while yy <= y1:
            xx = x0
            while xx <= x1:
                if 2 <= xx < IW - 2 and 2 <= yy < IH - 2 and pip(xx, yy, poly):
                    vals.append(ipx[int(xx), int(yy)])
                xx += stepx
            yy += stepo
        if len(vals) >= 6:
            ch = [sorted(v[i] for v in vals) for i in range(3)]
            r, g, bl = (c[len(c) // 2] for c in ch)
            greenish = g >= r + 3 and g >= bl + 5        # koruny nad střechou / budova na fotce ještě nestála
            bare = r - bl > 26 and r - g < 24 and 105 < r < 225   # hlína staveniště (taška má r−g výrazně větší)
            if not greenish:
                b['c'] = '#%02x%02x%02x' % (r, g, bl)
                b['bare'] = bare
    return b


def place_building(b, pts):
    if not pts or not any(abs(x) <= EXT and abs(y) <= EXT for x, y in pts):
        X, Y = px(*b['m'])
        if abs(X) <= EXT and abs(Y) <= EXT:
            print('  vynechána budova v silnici: %s (%d,%d)' % (b['t'], X, Y), file=sys.stderr)
        return None
    out = {'p': pts, 'l': b['l'], 't': b['t'], 'r': b['r']}
    if 'c' in b and not b.get('bare'):
        out['c'] = b['c']
    return out


if __name__ == '__main__':
    main()
