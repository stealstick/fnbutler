import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")  # .env 의 키/설정을 환경변수로 로드

BASE_URL = "https://www.fnguide.com"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required. Use a PostgreSQL connection string.")
COOKIE_FILE = Path(os.environ.get("FNGUIDE_COOKIE_FILE") or PROJECT_ROOT / ".secrets" / "cookie.txt")
PDF_DIR = PROJECT_ROOT / "data" / "pdfs"
REQUEST_DELAY = float(os.environ.get("FNGUIDE_REQUEST_DELAY", "1.0"))

# 자동 로그인 자격증명 (쿠키 만료 시 재로그인). 미설정이면 쿠키 파일만 사용.
USER_ID = os.environ.get("FNGUIDE_USER_ID") or ""
USER_PW = os.environ.get("FNGUIDE_USER_PW") or ""

# 증권사 리포트가 아닌 발행처 (해당기업 IR 자료 등) — 추정치 테이블이 없어 스킵
SKIP_BROKER_CODES = {"143"}
