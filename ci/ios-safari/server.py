# Test-only local server for the iPhone Simulator run. Never deployed: GitHub Pages serves main only.
# Serves the CI harness at /ci/ and the app at /ryans-reel-kit/ (same origin, so the harness can drive it).
# App source: a local checkout (argv[1] = path) or, with argv[1] = a https URL, a byte-for-byte proxy of the
# live GitHub Pages build (cache-busted so the CDN returns the latest deploy).
import http.server, json, os, subprocess, sys, urllib.parse, urllib.request, time
SRC = sys.argv[1]; LIVE = SRC.startswith('https://'); APP = None if LIVE else os.path.abspath(SRC)
CI = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.abspath(sys.argv[2]); BUST = str(int(time.time()))
os.makedirs(OUT, exist_ok=True)
STATE = {'offline': False}
TYPES = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream', '.txt': 'text/plain', '.md': 'text/plain'}
def log(line):
    with open(os.path.join(OUT, 'results.jsonl'), 'a') as f: f.write(line + '\n')
    print(line, flush=True)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *a): sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))
    def send(self, code, body=b'', ctype='text/plain'):
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); p = u.path
        if p.startswith('/ryans-reel-kit/'):
            if STATE['offline']:
                self.close_connection = True; self.connection.close(); return  # simulate no network
            rel = p[len('/ryans-reel-kit/'):] or 'index.html'
            if LIVE:
                url = SRC.rstrip('/') + '/' + rel + '?' + ((u.query + '&') if u.query else '') + 'cibust=' + BUST
                try:
                    with urllib.request.urlopen(url, timeout=60) as r: body = r.read(); ct = r.headers.get('Content-Type') or TYPES.get(os.path.splitext(rel)[1], 'application/octet-stream')
                    return self.send(200, body, ct.split(';')[0] if ct.startswith('text/javascript') else ct)
                except urllib.error.HTTPError as e: return self.send(e.code)
                except Exception as e: return self.send(502, str(e).encode())
            base = APP
        elif p.startswith('/ci/'): rel = p[4:]; base = CI
        else: return self.send(404)
        fp = os.path.normpath(os.path.join(base, rel))
        if not fp.startswith(base) or not os.path.isfile(fp): return self.send(404)
        with open(fp, 'rb') as f: self.send(200, f.read(), TYPES.get(os.path.splitext(fp)[1], 'application/octet-stream'))
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query))
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if u.path == '/ci/log': log(body.decode('utf-8', 'replace'))
        elif u.path == '/ci/shot':
            name = ''.join(c for c in q.get('name', 'shot') if c.isalnum() or c in '-_')
            try: subprocess.run(['xcrun', 'simctl', 'io', 'booted', 'screenshot', os.path.join(OUT, name + '.png')], capture_output=True, timeout=30)
            except Exception as e: log(json.dumps({'shot_error': str(e)}))
        elif u.path == '/ci/offline': STATE['offline'] = q.get('on') == '1'; log(json.dumps({'offline': STATE['offline']}))
        elif u.path == '/ci/upload':
            name = os.path.basename(q.get('name', 'upload.bin'))
            with open(os.path.join(OUT, name), 'wb') as f: f.write(body)
        elif u.path == '/ci/done': open(os.path.join(OUT, 'done'), 'w').write('1')
        self.send(200, b'ok')
log(json.dumps({'server': 'start', 'source': SRC, 'live': LIVE}))
http.server.ThreadingHTTPServer(('127.0.0.1', 8123), H).serve_forever()
