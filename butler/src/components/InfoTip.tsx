/**
 * 물음표(ⓘ) 아이콘 + 마우스 호버 툴팁. JS 없이 CSS 로만 동작(서버 컴포넌트 가능).
 * 모바일/접근성 위해 title 속성도 함께 단다.
 */
export default function InfoTip({ text }: { text: string }) {
  return (
    <span className="infotip" title={text} tabIndex={0} aria-label={text}>
      <span className="infotip-icon">?</span>
      <span className="infotip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}
