import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  loginPage: {
    backgroundColor: "var(--color-background-body)",
  },
  loginCard: {
    padding: "clamp(var(--spacing-4), 6vw, var(--spacing-8))",
  },
  chatContent: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  welcome: {
    marginInline: "auto",
    paddingBlock: "var(--spacing-8)",
    paddingInline: "var(--spacing-4)",
  },
  composer: {
    minWidth: 0,
  },
  composerInput: {
    minHeight: "calc(var(--spacing-10) * 2)",
  },
  modelSelector: {
    minWidth: 0,
    maxWidth: "clamp(8rem, 35vw, 16rem)",
  },
  messageContent: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  messageText: {
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
});
