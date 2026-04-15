import logoLight from "../assets/logo-light-wordmark.svg";

export function ArkLogo({ className = "", height = 32 }: { className?: string; height?: number }) {
  return (
    <img
      src={logoLight}
      height={height}
      style={{ height }}
      className={className}
      alt="Ark Media"
    />
  );
}
