import logoLight from "../assets/logo-light-wordmark.svg";
import logoDark from "../assets/logo-dark-wordmark.svg";
import { useTheme } from "../lib/theme";

export function ArkLogo({ className = "", height = 32 }: { className?: string; height?: number }) {
  const { theme } = useTheme();
  const src = theme === "light" ? logoDark : logoLight;
  return (
    <img
      src={src}
      height={height}
      style={{ height }}
      className={className}
      alt="Ark Media"
    />
  );
}
