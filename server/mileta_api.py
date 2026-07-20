#!/usr/bin/env python3
"""Mini API pro žebříček hry Mileta (izovan.cz/mileta).

GET  /scores -> {"top": [...50], "total": N}
GET  /scores/recent -> {"recent": [...50 nejnovějších], "total": N}
POST /scores {"name": str, "score": int, "time": int, "stats": {...}?}
     -> {"rank": R, "total": N, "top": [...]}
     stats (volitelné, klíč 'x' v záznamu): p=vozidel, q=nejdelší kolona,
     w=prům. zdržení [s], eo/ef=IZS včas/pozdě, mo/mf=MHD včas/pozdě
GET  /online -> {"online": N}                    # kolik hráčů právě hraje
POST /online {"id": str} -> {"online": N}        # heartbeat hráče (TTL 75 s)

Běží na 127.0.0.1:2780, nginx to proxuje na /mileta/api/.
"""
import json
import os
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scores.json')
LOCK = threading.Lock()
MAX_ENTRIES = 500

# hráči online: id -> čas posledního heartbeatu (jen v paměti, restart nuluje)
ONLINE = {}
ONLINE_TTL = 75          # heartbeat chodí à 30 s; kdo 75 s mlčí, už nehraje
ONLINE_MAX = 500


def online_count(now):
    for k in [k for k, ts in ONLINE.items() if now - ts > ONLINE_TTL]:
        del ONLINE[k]
    return len(ONLINE)


def load():
    try:
        with open(DB) as f:
            return json.load(f)
    except Exception:
        return []


def save(data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DB))
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, DB)


def ranked(data):
    # víc bodů líp; při shodě je líp kratší čas (efektivita)
    return sorted(data, key=lambda e: (-e['s'], e['t']))


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.rstrip('/')
        if path in ('', '/scores'):
            with LOCK:
                data = ranked(load())
            self._json(200, {'top': data[:50], 'total': len(data)})
        elif path == '/scores/recent':
            with LOCK:
                data = load()
            # d je 'YYYY-MM-DD HH:MM', takže textové řazení = chronologické
            recent = sorted(data, key=lambda e: e.get('d', ''), reverse=True)
            self._json(200, {'recent': recent[:50], 'total': len(data)})
        elif path == '/online':
            with LOCK:
                n = online_count(time.time())
            self._json(200, {'online': n})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        path = self.path.rstrip('/')
        if path == '/online':
            try:
                ln = min(int(self.headers.get('Content-Length', 0)), 256)
                req = json.loads(self.rfile.read(ln))
                cid = str(req['id'])
                assert re.fullmatch(r'[A-Za-z0-9]{4,32}', cid)
            except Exception:
                return self._json(400, {'error': 'bad request'})
            now = time.time()
            with LOCK:
                if cid in ONLINE or len(ONLINE) < ONLINE_MAX:
                    ONLINE[cid] = now
                n = online_count(now)
            return self._json(200, {'online': n})
        if path not in ('', '/scores'):
            return self._json(404, {'error': 'not found'})
        try:
            ln = min(int(self.headers.get('Content-Length', 0)), 4096)
            req = json.loads(self.rfile.read(ln))
            name = re.sub(r'[\x00-\x1f<>&"\']', '', str(req['name'])).strip()[:24]
            score = int(req['score'])
            t = int(req['time'])
            assert name and 0 <= score <= 99999 and 0 <= t <= 86400
        except Exception:
            return self._json(400, {'error': 'bad request'})
        x = None
        if isinstance(req.get('stats'), dict):
            try:
                rs = req['stats']
                x = {k: max(0, min(10**6, int(rs[k])))
                     for k in ('p', 'q', 'eo', 'ef', 'mo', 'mf')}
                x['w'] = max(0.0, min(9999.0, round(float(rs['w']), 1)))
            except Exception:
                x = None
        entry = {'n': name, 's': score, 't': t, 'd': time.strftime('%Y-%m-%d %H:%M')}
        if x:
            entry['x'] = x
        with LOCK:
            data = load()
            data.append(entry)
            data = ranked(data)[:MAX_ENTRIES]
            save(data)
            rank = sum(1 for e in data if (-e['s'], e['t']) < (-score, t)) + 1
        self._json(200, {'rank': rank, 'total': len(data), 'top': data[:50]})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 2780), Handler).serve_forever()
