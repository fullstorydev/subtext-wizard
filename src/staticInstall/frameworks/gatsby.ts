import { SCRIPT_ID, jsString } from '../edit/js.js';
import type { EditResult } from '../edit/text.js';
import { firstExisting, hasDep } from '../project.js';
import { type Framework, fail, withExts } from './types.js';

const NAME = 'Gatsby';

export const gatsby: Framework = {
  name: NAME,
  matches: (project) => hasDep(project, 'gatsby'),
  detect(project) {
    const existing = firstExisting(project, withExts('gatsby-ssr', ['js', 'jsx', 'ts', 'tsx']));
    if (existing) return fail(`${existing} already exists and would need merging`, NAME);
    const file = `gatsby-ssr.${project.typescript ? 'tsx' : 'js'}`;
    return { ok: true, plan: { framework: NAME, file, create: ({ body }) => createSsr(body, project.typescript) } };
  },
};

function createSsr(body: string, typescript: boolean): EditResult {
  const signature = typescript
    ? `import type { GatsbySSR } from "gatsby";

export const onRenderBody: GatsbySSR["onRenderBody"] = ({ setHeadComponents }) => {`
    : `export const onRenderBody = ({ setHeadComponents }) => {`;
  const content = `import * as React from "react";
${signature}
  setHeadComponents([
    <script key="${SCRIPT_ID}" id="${SCRIPT_ID}" dangerouslySetInnerHTML={{ __html: ${jsString(body)} }} />,
  ]);
};
`;
  return { content, inserted: content };
}
