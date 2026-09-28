/**
 * Stylesheet embedded in every generated page.
 *
 * The CHM viewer uses MSHTML in IE7-era standards mode, so this sticks to
 * px units, floats, borders and backgrounds. No flexbox, no grid, no CSS
 * variables, no rem — anything relying on those silently disappears.
 */
export const CHM_CSS = `
body {
	font-family: "Segoe UI", Tahoma, Verdana, sans-serif;
	font-size: 13px;
	line-height: 1.6;
	color: #24292e;
	background: #ffffff;
	margin: 0;
	padding: 22px 28px 60px 28px;
	max-width: 820px;
}

h1, h2, h3, h4, h5, h6 {
	font-family: "Segoe UI", Tahoma, Verdana, sans-serif;
	color: #1b1f23;
	line-height: 1.3;
	margin: 26px 0 10px 0;
	font-weight: 600;
}

h1 {
	font-size: 24px;
	border-bottom: 1px solid #e1e4e8;
	padding-bottom: 8px;
	margin-top: 0;
}
h2 {
	font-size: 19px;
	border-bottom: 1px solid #eaecef;
	padding-bottom: 5px;
}
h3 { font-size: 16px; }
h4 { font-size: 14px; }
h5 { font-size: 13px; }
h6 { font-size: 12px; color: #6a737d; }

p { margin: 0 0 12px 0; }

a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }

ul, ol { margin: 0 0 12px 0; padding-left: 26px; }
li { margin: 3px 0; }

blockquote {
	margin: 0 0 12px 0;
	padding: 2px 0 2px 14px;
	border-left: 3px solid #dfe2e5;
	color: #6a737d;
}

hr {
	border: 0;
	border-top: 1px solid #e1e4e8;
	margin: 22px 0;
}

code {
	font-family: Consolas, "Courier New", monospace;
	font-size: 12px;
	background: #f6f8fa;
	border: 1px solid #eaecef;
	padding: 1px 4px;
}

pre {
	font-family: Consolas, "Courier New", monospace;
	font-size: 12px;
	line-height: 1.5;
	background: #f6f8fa;
	border: 1px solid #e1e4e8;
	padding: 10px 12px;
	margin: 0 0 12px 0;
	overflow: auto;
	white-space: pre;
}

pre code {
	background: transparent;
	border: 0;
	padding: 0;
}

table {
	border-collapse: collapse;
	margin: 0 0 14px 0;
	font-size: 12px;
}

th, td {
	border: 1px solid #dfe2e5;
	padding: 6px 10px;
	text-align: left;
	vertical-align: top;
}

th {
	background: #f6f8fa;
	font-weight: 600;
}

img {
	max-width: 100%;
	border: 0;
}

/* Obsidian callouts ------------------------------------------------ */

.callout {
	border: 1px solid #d0d7de;
	border-left: 4px solid #0969da;
	background: #f6f8fa;
	padding: 10px 14px;
	margin: 0 0 14px 0;
}

.callout-title {
	font-weight: 600;
	color: #1b1f23;
	margin-bottom: 4px;
}

.callout-content > p:last-child { margin-bottom: 0; }

.callout[data-callout="warning"],
.callout[data-callout="caution"] { border-left-color: #bf8700; }
.callout[data-callout="danger"],
.callout[data-callout="error"] { border-left-color: #cf222e; }
.callout[data-callout="tip"],
.callout[data-callout="success"] { border-left-color: #1a7f37; }

/* Embedded notes --------------------------------------------------- */

.markdown-embed {
	border-left: 3px solid #dfe2e5;
	background: #fafbfc;
	padding: 8px 14px;
	margin: 0 0 14px 0;
}

.markdown-embed-title {
	font-weight: 600;
	margin-bottom: 6px;
}

.markdown-embed .markdown-embed { background: transparent; }

/* Links that pointed outside the exported set ---------------------- */

.mdtoc-dead-link {
	color: #6a737d;
	border-bottom: 1px dotted #d0d7de;
}

/* Obsidian noise that has no meaning in a CHM ---------------------- */

.frontmatter,
.mod-frontmatter,
.markdown-preview-pusher,
.internal-embed.is-loaded > .file-embed { display: none; }

.tasks-list-text { margin-left: 4px; }
`;
