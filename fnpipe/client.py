"""fnguide.com HTTP 클라이언트.

인증: 브라우저에서 복사한 세션 쿠키(.secrets/cookie.txt) 사용.
PDF 다운로드 2단계 플로우:
  1) GET /Research/PdfViewer?rptId=N  → hidden input #documentData (요청마다 새로 발급되는
     단기 토큰. 미리 복사해둔 값은 만료되어 400이 난다 — 반드시 매번 새로 추출)
  2) POST /Research/GetPdfFile (multipart, documentData=토큰)
     → {"dataSet": "data:application/pdf;base64,..."}
"""
import base64
import html
import json
import re
import time
from datetime import date

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from . import config


class FnGuideError(RuntimeError):
    pass


class AuthExpiredError(FnGuideError):
    """세션 쿠키 만료 — .secrets/cookie.txt 를 브라우저에서 새로 복사해야 함."""


class SyncfusionBlockedError(FnGuideError):
    """일부 리포트(예: 한국투자증권)는 Syncfusion 뷰어 + 다운로드 차단.

    GetPdfFile용 documentData가 없고 documentPath(Syncfusion)만 있다.
    서버의 Load는 되지만 Download/RenderPdfPages는 403으로 막혀 HTTP로 PDF를
    받을 수 없다 → 브라우저 자동화 폴백이 필요. documentPath를 함께 실어 보낸다.
    """

    def __init__(self, rpt_id: int, document_path: str):
        super().__init__(f"rptId={rpt_id}: Syncfusion 뷰어(다운로드 차단) — 브라우저 폴백 필요")
        self.rpt_id = rpt_id
        self.document_path = document_path


_DOCDATA_RE = re.compile(r'id="documentData"[^>]*value="([^"]*)"')
_DOCPATH_RE = re.compile(r'"documentPath":\s*"([^"]+)"')
_TOKEN_RE = re.compile(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"')
_LOGINJS_RE = re.compile(r'src="(/bundles/users/login[^"]*)"')
_PUBKEY_RE = re.compile(r'-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----')


class FnGuideClient:
    def __init__(self, cookie_string: str | None = None):
        self.sess = requests.Session()
        self.sess.headers.update({
            "User-Agent": config.USER_AGENT,
            "Accept-Language": "ko,en-US;q=0.8,en;q=0.7",
        })
        if cookie_string is None and config.COOKIE_FILE.exists():
            cookie_string = config.COOKIE_FILE.read_text().strip()
        if cookie_string:
            self.sess.headers["Cookie"] = cookie_string
        elif not (config.USER_ID and config.USER_PW):
            raise FnGuideError(
                "쿠키 파일도 없고 자동 로그인 자격증명(FNGUIDE_USER_ID/PW)도 없습니다.")

    def _sleep(self):
        time.sleep(config.REQUEST_DELAY)

    # --------------------------------------------------------------- 자동 로그인
    @staticmethod
    def _normalize_pem(raw: str) -> bytes:
        body = (raw.replace("`", "").replace("\\n", "").replace("\n", "")
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "").strip())
        lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
        return f"-----BEGIN PUBLIC KEY-----\n{lines}\n-----END PUBLIC KEY-----\n".encode()

    def login(self) -> None:
        """ID/PW로 로그인해 세션 쿠키를 발급받고 쿠키 파일에 저장.

        비밀번호는 로그인 JS에 박힌 공개키로 RSA-OAEP(SHA-256) 암호화해 전송한다.
        세션 쿠키(헤더의 Cookie)는 제거하고 쿠키 jar 기반으로 전환한다.
        """
        if not (config.USER_ID and config.USER_PW):
            raise AuthExpiredError("쿠키 만료 + 자동 로그인 자격증명 없음 — 쿠키 재복사 필요")
        self.sess.headers.pop("Cookie", None)
        self.sess.cookies.clear()

        lp = self.sess.get(f"{config.BASE_URL}/Users/Login", timeout=30)
        lp.raise_for_status()
        tok = _TOKEN_RE.search(lp.text)
        js_m = _LOGINJS_RE.search(lp.text)
        if not tok or not js_m:
            raise FnGuideError("로그인 페이지에서 토큰/JS를 찾지 못함")
        js = self.sess.get(config.BASE_URL + js_m.group(1), timeout=30).text
        key_m = _PUBKEY_RE.search(js)
        if not key_m:
            raise FnGuideError("로그인 JS에서 공개키를 찾지 못함")
        pub = serialization.load_pem_public_key(self._normalize_pem(key_m.group(0)))
        enc_pw = base64.b64encode(pub.encrypt(
            config.USER_PW.encode(),
            padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                         algorithm=hashes.SHA256(), label=None))).decode()

        fields = {
            "userId": config.USER_ID, "userPassword": enc_pw, "loginType": "1",
            "returnUrl": "", "__RequestVerificationToken": tok.group(1),
            "isLogin": "", "loginUserId": "", "isSessionExpired": "", "menuName": "",
        }
        r = self.sess.post(
            f"{config.BASE_URL}/Users/UserLogin",
            files={k: (None, v) for k, v in fields.items()},
            headers={"Origin": config.BASE_URL,
                     "Referer": f"{config.BASE_URL}/Users/Login",
                     "X-Requested-With": "XMLHttpRequest"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        if body.get("returnCode") != 0:
            raise AuthExpiredError(f"로그인 실패: {body.get('returnMessage')} {body.get('dataSet')}")
        self._save_cookies()

    def _save_cookies(self) -> None:
        jar = "; ".join(f"{c.name}={c.value}" for c in self.sess.cookies)
        config.COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.COOKIE_FILE.write_text(jar)

    def _with_relogin(self, fn, *args, **kwargs):
        """AuthExpiredError 발생 시 1회 자동 로그인 후 재시도."""
        try:
            return fn(*args, **kwargs)
        except AuthExpiredError:
            if not (config.USER_ID and config.USER_PW):
                raise
            self.login()
            return fn(*args, **kwargs)

    # ------------------------------------------------------------------ 목록
    def get_reports(self, *, company_code: str, keyword: str, from_dt: date,
                    to_dt: date, page: int = 1, per_page: int = 20) -> dict:
        """POST /Research/GetReports — 기업별 리포트 목록 1페이지."""
        fields = {
            "srchTyp": "1",                  # 1 = 기업 검색
            "srchKeyword": keyword,
            "srchCode": company_code,
            "fromDt": from_dt.isoformat(),
            "toDt": to_dt.isoformat(),
            "exclBlind": "false",
            "menuCd": "1010",
            "curPage": str(page),
            "perPage": str(per_page),
            "ordCol": "", "ordDir": "",
            "useDb": "false",
        }
        r = self.sess.post(
            f"{config.BASE_URL}/Research/GetReports",
            files={k: (None, v) for k, v in fields.items()},  # multipart/form-data
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Origin": config.BASE_URL,
                "Referer": f"{config.BASE_URL}/Research/SearchReport",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=30,
        )
        if r.status_code in (401, 403) or "/Users/Login" in r.url:
            raise AuthExpiredError(f"HTTP {r.status_code}")
        r.raise_for_status()
        body = r.json()
        if body.get("returnCode") != 0:
            raise FnGuideError(f"GetReports 실패: {body.get('returnMessage')} {body.get('dataSet')}")
        return body["dataSet"]

    def iter_reports(self, *, company_code: str, keyword: str,
                     from_dt: date, to_dt: date):
        """페이지네이션을 따라가며 리포트 메타데이터를 yield."""
        page = 1
        while True:
            ds = self._with_relogin(self.get_reports, company_code=company_code,
                                    keyword=keyword, from_dt=from_dt, to_dt=to_dt, page=page)
            reports = ds.get("reports") or []
            yield from reports
            info = (ds.get("searchInfo") or [{}])[0]
            total = int(info.get("TOTAL_CNT") or 0)
            if page * 20 >= total or not reports:
                break
            page += 1
            self._sleep()

    # ------------------------------------------------------------ 전 종목 피드
    def get_feed(self, *, from_dt: date, to_dt: date, page: int = 1,
                 per_page: int = 50) -> dict:
        """POST /Research/GetReports (srchTyp=0) — 전 종목 최신 리포트 피드.

        기업별로 N번 조회하는 대신 하루치 신규 리포트를 한 번에 받아, 등록된
        기업만 골라 처리하기 위한 경로. 날짜는 'YYYY.MM.DD' 형식을 쓴다.
        """
        fields = {
            "estTyp": "2", "action": "0", "period": "3",
            "fromDt": from_dt.strftime("%Y.%m.%d"),
            "toDt": to_dt.strftime("%Y.%m.%d"),
            "exclBlind": "false", "srchTyp": "0", "srchKeyword": "", "srchCode": "",
            "menuCd": "101010", "curPage": str(page), "perPage": str(per_page),
            "ordCol": "ANL_DT", "ordDir": "D", "useDb": "false",
        }
        r = self.sess.post(
            f"{config.BASE_URL}/Research/GetReports",
            files={k: (None, v) for k, v in fields.items()},
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Origin": config.BASE_URL,
                "Referer": f"{config.BASE_URL}/Research/SearchReport",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=30,
        )
        if r.status_code in (401, 403) or "/Users/Login" in r.url:
            raise AuthExpiredError(f"HTTP {r.status_code}")
        r.raise_for_status()
        body = r.json()
        if body.get("returnCode") != 0:
            raise FnGuideError(f"GetReports(feed) 실패: {body.get('returnMessage')}")
        return body["dataSet"]

    def iter_feed(self, *, from_dt: date, to_dt: date, max_pages: int = 200):
        """전 종목 피드를 날짜 역순으로 페이지네이션하며 yield."""
        page = 1
        while page <= max_pages:
            ds = self._with_relogin(self.get_feed, from_dt=from_dt, to_dt=to_dt,
                                    page=page, per_page=50)
            reports = ds.get("reports") or []
            yield from reports
            info = (ds.get("searchInfo") or [{}])[0]
            total = int(info.get("TOTAL_CNT") or 0)
            if page * 50 >= total or not reports:
                break
            page += 1
            self._sleep()

    # ------------------------------------------------------------------ PDF
    def fetch_document_data(self, rpt_id: int) -> str:
        r = self.sess.get(
            f"{config.BASE_URL}/Research/PdfViewer",
            params={"rptId": rpt_id},
            headers={"Accept": "text/html,application/xhtml+xml"},
            timeout=30,
        )
        if "/Users/Login" in r.url or r.status_code in (401, 403):
            raise AuthExpiredError("PdfViewer가 로그인 페이지로 리다이렉트됨")
        r.raise_for_status()
        m = _DOCDATA_RE.search(r.text)
        if m and m.group(1):
            return html.unescape(m.group(1))
        # documentData가 없으면 Syncfusion 뷰어인지 확인 (다운로드 차단 케이스)
        mp = _DOCPATH_RE.search(r.text)
        if mp and mp.group(1):
            raise SyncfusionBlockedError(rpt_id, mp.group(1))
        raise FnGuideError(f"rptId={rpt_id}: documentData를 찾지 못함 (권한/블라인드 리포트?)")

    def download_pdf(self, rpt_id: int) -> bytes:
        # SyncfusionBlockedError 는 재로그인 대상이 아니므로 그대로 전파된다
        return self._with_relogin(self._download_pdf, rpt_id)

    def _download_pdf(self, rpt_id: int) -> bytes:
        doc_data = self.fetch_document_data(rpt_id)
        self._sleep()
        r = self.sess.post(
            f"{config.BASE_URL}/Research/GetPdfFile",
            files={"documentData": (None, doc_data)},
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Origin": config.BASE_URL,
                "Referer": f"{config.BASE_URL}/Research/PdfViewer?rptId={rpt_id}",
                "X-Requested-With": "XMLHttpRequest",
            },
            timeout=60,
        )
        r.raise_for_status()
        try:
            data_url = r.json()["dataSet"]
            b64 = data_url.split("base64,", 1)[1]
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            raise FnGuideError(f"rptId={rpt_id}: GetPdfFile 응답 형식 이상 — {r.text[:200]}") from e
        pdf = base64.b64decode(b64)
        if not pdf.startswith(b"%PDF"):
            raise FnGuideError(f"rptId={rpt_id}: PDF 시그니처가 아님")
        return pdf
