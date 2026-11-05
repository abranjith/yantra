// Intentional Drshya violation: raw HTML injection.
export const raw = <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />;
