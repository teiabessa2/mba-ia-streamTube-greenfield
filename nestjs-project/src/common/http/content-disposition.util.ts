const DEL_CHAR_CODE = 0x7f;
const FIRST_PRINTABLE_CHAR_CODE = 0x20;

/** Whether `char` would break a header quoted-string: `"`, `\` or a control character. */
const isUnsafeInQuotedString = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (
    code < FIRST_PRINTABLE_CHAR_CODE ||
    code === DEL_CHAR_CODE ||
    char === '"' ||
    char === '\\'
  );
};

/** `attachment; filename="..."` with the unsafe characters removed. */
export const attachmentDisposition = (fileName: string): string => {
  const safeName = Array.from(fileName)
    .filter((char) => !isUnsafeInQuotedString(char))
    .join('');
  return `attachment; filename="${safeName}"`;
};
