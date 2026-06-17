import { createTheme, type Theme } from "@mui/material/styles";

// MUI is our deliberate divergence from the sandbox's @reliability-design tokens; ApplicationContext
// holds the active theme NAME, and the tree resolves it to one of these instances (light default).
export type ThemeName = "light" | "dark";

const light = createTheme({
  palette: { mode: "light", primary: { main: "#3949ab" }, secondary: { main: "#00897b" } },
});

const dark = createTheme({
  palette: { mode: "dark", primary: { main: "#7986cb" }, secondary: { main: "#4db6ac" } },
});

export const themes: Record<ThemeName, Theme> = { light, dark };

export const resolveTheme = (name: ThemeName): Theme => themes[name] ?? light;
