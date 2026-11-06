import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#c45c26" },
    secondary: { main: "#2f5d50" },
    background: { default: "#f4f6f8", paper: "#ffffff" },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h6: { fontWeight: 600 },
  },
  shape: { borderRadius: 10 },
});
