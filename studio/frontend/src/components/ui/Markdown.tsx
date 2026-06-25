import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Thin, swappable seam: the ONLY place the markdown library is named. Raw HTML is
// inert (no rehype-raw / dangerouslySetInnerHTML) — that default is the security
// boundary. Visual styling lives in the `.bloom-md` token block in styles.css.
const components: Components = {
  // Open links in a new tab safely. `node` (the hast node) must be stripped so it
  // is not spread onto the DOM <a>; `void node` keeps the lint clean.
  a({ node, ...props }) {
    void node;
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="bloom-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
