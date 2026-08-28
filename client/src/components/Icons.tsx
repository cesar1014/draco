import type { SVGProps } from "react";

/**
 * Ícones em SVG inline num grid de 24 px. Todos herdam `currentColor`, então quem
 * define a aparência é o CSS do botão.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Risco diagonal dos ícones "desligado". A cor acompanha o fundo do botão. */
const Slash = () => (
  <path d="M3.3 2 22 20.7l-1.4 1.4L1.9 3.4 3.3 2Z" stroke="var(--slash)" strokeWidth="1.4" />
);

export const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.5a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0V6A3.5 3.5 0 0 0 12 2.5Z" />
    <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.07A7 7 0 0 0 19 11Z" />
  </Icon>
);

export const MicOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.5a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0V6A3.5 3.5 0 0 0 12 2.5Z" />
    <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.07A7 7 0 0 0 19 11Z" />
    <Slash />
  </Icon>
);

export const HeadphoneIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.5A9.5 9.5 0 0 0 2.5 12v5.5A2.5 2.5 0 0 0 5 20h1.5a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H4.5V12a7.5 7.5 0 0 1 15 0v-1h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H19a2.5 2.5 0 0 0 2.5-2.5V12A9.5 9.5 0 0 0 12 2.5Z" />
  </Icon>
);

export const HeadphoneOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.5A9.5 9.5 0 0 0 2.5 12v5.5A2.5 2.5 0 0 0 5 20h1.5a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H4.5V12a7.5 7.5 0 0 1 15 0v-1h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H19a2.5 2.5 0 0 0 2.5-2.5V12A9.5 9.5 0 0 0 12 2.5Z" />
    <Slash />
  </Icon>
);

export const CameraIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6.5A2.5 2.5 0 0 0 1.5 9v6A2.5 2.5 0 0 0 4 17.5h9A2.5 2.5 0 0 0 15.5 15V9A2.5 2.5 0 0 0 13 6.5H4Zm13 4.2 4.1-2.6a1 1 0 0 1 1.4.9v6a1 1 0 0 1-1.4.9L17 13.3v-2.6Z" />
  </Icon>
);

export const CameraOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6.5A2.5 2.5 0 0 0 1.5 9v6A2.5 2.5 0 0 0 4 17.5h9A2.5 2.5 0 0 0 15.5 15V9A2.5 2.5 0 0 0 13 6.5H4Zm13 4.2 4.1-2.6a1 1 0 0 1 1.4.9v6a1 1 0 0 1-1.4.9L17 13.3v-2.6Z" />
    <Slash />
  </Icon>
);

export const ScreenIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 3.5A1.5 1.5 0 0 0 1.5 5v11A1.5 1.5 0 0 0 3 17.5h7.5v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-2.5v-2H21a1.5 1.5 0 0 0 1.5-1.5V5A1.5 1.5 0 0 0 21 3.5H3Zm9.7 3.3 3.5 3.4a1 1 0 0 1-.7 1.7h-1.8v2.6a1 1 0 0 1-1 1h-1.4a1 1 0 0 1-1-1v-2.6H8.5a1 1 0 0 1-.7-1.7l3.5-3.4a1 1 0 0 1 1.4 0Z" />
  </Icon>
);

export const ScreenOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 3.5A1.5 1.5 0 0 0 1.5 5v11A1.5 1.5 0 0 0 3 17.5h7.5v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-2.5v-2H21a1.5 1.5 0 0 0 1.5-1.5V5A1.5 1.5 0 0 0 21 3.5H3Z" />
    <Slash />
  </Icon>
);

export const HangUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 8.5c-3.6 0-7 .9-9.9 2.5a1.6 1.6 0 0 0-.7 2.1l1 2a1.6 1.6 0 0 0 2 .8l2.5-.9a1.6 1.6 0 0 0 1-1.5v-1.2c1.3-.3 2.6-.5 4.1-.5s2.8.2 4.1.5v1.2c0 .7.4 1.3 1 1.5l2.5.9a1.6 1.6 0 0 0 2-.8l1-2a1.6 1.6 0 0 0-.7-2.1A21.4 21.4 0 0 0 12 8.5Z" />
  </Icon>
);

export const GearIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm9-4.6-2-.4a7.4 7.4 0 0 0-.7-1.7l1.2-1.6a.6.6 0 0 0-.1-.8l-1.4-1.4a.6.6 0 0 0-.8-.1l-1.6 1.2a7.4 7.4 0 0 0-1.7-.7l-.4-2a.6.6 0 0 0-.6-.5h-2a.6.6 0 0 0-.6.5l-.4 2a7.4 7.4 0 0 0-1.7.7L6.6 4.9a.6.6 0 0 0-.8.1L4.4 6.4a.6.6 0 0 0-.1.8l1.2 1.6a7.4 7.4 0 0 0-.7 1.7l-2 .4a.6.6 0 0 0-.5.6v2a.6.6 0 0 0 .5.6l2 .4c.2.6.4 1.2.7 1.7l-1.2 1.6a.6.6 0 0 0 .1.8l1.4 1.4a.6.6 0 0 0 .8.1l1.6-1.2c.5.3 1.1.5 1.7.7l.4 2a.6.6 0 0 0 .6.5h2a.6.6 0 0 0 .6-.5l.4-2c.6-.2 1.2-.4 1.7-.7l1.6 1.2a.6.6 0 0 0 .8-.1l1.4-1.4a.6.6 0 0 0 .1-.8l-1.2-1.6c.3-.5.5-1.1.7-1.7l2-.4a.6.6 0 0 0 .5-.6v-2a.6.6 0 0 0-.5-.6Z" />
  </Icon>
);

export const HashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.2 3 9.5 8H5.6l-.3 2h3.9l-.6 4H4.7l-.3 2h4l-.7 5h2l.7-5h4l-.7 5h2l.7-5h3.9l.3-2h-3.9l.6-4h3.9l.3-2h-3.9l.7-5h-2l-.7 5h-4l.7-5h-2Zm.6 7h4l-.6 4h-4l.6-4Z" />
  </Icon>
);

export const SpeakerIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11.4 3.2a1 1 0 0 1 .6.9v15.8a1 1 0 0 1-1.6.8L5.6 17H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2.6l4.8-3.7a1 1 0 0 1 1-.1Zm4.3 3.5a1 1 0 0 1 1.4.1 8 8 0 0 1 0 10.4 1 1 0 1 1-1.5-1.3 6 6 0 0 0 0-7.8 1 1 0 0 1 .1-1.4Z" />
  </Icon>
);

export const SpeakerOffIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11.4 3.2a1 1 0 0 1 .6.9v15.8a1 1 0 0 1-1.6.8L5.6 17H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2.6l4.8-3.7a1 1 0 0 1 1-.1Z" />
    <path d="M22 9.4 20.6 8l-2.1 2.1L16.4 8 15 9.4l2.1 2.1L15 13.6l1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1L22 9.4Z" />
  </Icon>
);

export const ExpandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z" />
  </Icon>
);

export const CollapseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10 4h2v6H6V8h4V4Zm4 0h2v4h4v2h-6V4ZM4 14h6v6H8v-4H4v-2Zm10 0h6v2h-4v4h-2v-6Z" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18.4 4.2 12 10.6 5.6 4.2 4.2 5.6 10.6 12l-6.4 6.4 1.4 1.4L12 13.4l6.4 6.4 1.4-1.4L13.4 12l6.4-6.4-1.4-1.4Z" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 5.5h18v2H3v-2Zm0 5.5h18v2H3v-2Zm0 5.5h18v2H3v-2Z" />
  </Icon>
);

/** Setinha de espelhar imagem. */
export const FlipIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 2h2v20h-2V2Zm-2 3.6v12.8L2.4 12 9 5.6Zm6 0L21.6 12 15 18.4V5.6Z" />
  </Icon>
);

/** Duas setas trocando de lado: frontal ↔ traseira. */
export const SwitchCameraIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h12V4.5L21 8l-5 3.5V9H4V7Z" />
    <path d="M20 15H8v-2.5L3 16l5 3.5V17h12v-2Z" />
  </Icon>
);

/** Barrinhas de sinal, pro indicador de qualidade da conexão. */
export const SignalIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 15h3v6H3v-6Zm5.5-4h3v10h-3V11ZM14 7h3v14h-3V7Zm5.5-4h3v18h-3V3Z" />
  </Icon>
);

export const SlidersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6h9a3 3 0 0 1 5.7 0H20v2h-1.3a3 3 0 0 1-5.7 0H4V6Zm0 10h3.3a3 3 0 0 1 5.7 0h7v2h-7a3 3 0 0 1-5.7 0H4v-2Z" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z" />
  </Icon>
);

export const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.4 3.1 21 12 3.4 20.9 6 12 3.4 3.1ZM7.7 12l-1.4 4.9L16.4 12 6.3 7.1 7.7 12Z" />
  </Icon>
);

const MAGNIFIER =
  "M10.5 3a7.5 7.5 0 1 0 4.55 13.46l4.24 4.25 1.42-1.42-4.25-4.24A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z";

export const ZoomInIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d={MAGNIFIER} />
    <path d="M9.5 7h2v2.5H14v2h-2.5V14h-2v-2.5H7v-2h2.5V7Z" />
  </Icon>
);

export const ZoomOutIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d={MAGNIFIER} />
    <path d="M7 9.5h7v2H7v-2Z" />
  </Icon>
);

export const PlayIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 5.14a1 1 0 0 1 1.5-.87l9.2 5.36a1 1 0 0 1 0 1.73l-9.2 5.36A1 1 0 0 1 8 15.9V5.14Z" />
  </Icon>
);

export const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);

/** Setas pra fora: tela inteira do monitor, não só do palco. */
export const FullscreenIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4h7v2.2H6.2V11H4V4Zm9 0h7v7h-2.2V6.2H13V4ZM4 13h2.2v4.8H11V20H4v-7Zm13.8 0H20v7h-7v-2.2h4.8V13Z" />
  </Icon>
);

export const ExitFullscreenIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 4h2.2v7H4.2V8.8H9V4Zm3.8 0H15v4.8h4.8V11h-7V4ZM4.2 13h7v7H9v-4.8H4.2V13Zm8.6 0h7v2.2H15V20h-2.2v-7Z" />
  </Icon>
);

export const GridIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4.8A1.8 1.8 0 0 1 5.8 3h3.4A1.8 1.8 0 0 1 11 4.8v3.4A1.8 1.8 0 0 1 9.2 10H5.8A1.8 1.8 0 0 1 4 8.2V4.8Zm9 0A1.8 1.8 0 0 1 14.8 3h3.4A1.8 1.8 0 0 1 20 4.8v3.4A1.8 1.8 0 0 1 18.2 10h-3.4A1.8 1.8 0 0 1 13 8.2V4.8ZM4 15.8A1.8 1.8 0 0 1 5.8 14h3.4A1.8 1.8 0 0 1 11 15.8v3.4A1.8 1.8 0 0 1 9.2 21H5.8A1.8 1.8 0 0 1 4 19.2v-3.4Zm9 0A1.8 1.8 0 0 1 14.8 14h3.4A1.8 1.8 0 0 1 20 15.8v3.4A1.8 1.8 0 0 1 18.2 21h-3.4A1.8 1.8 0 0 1 13 19.2v-3.4Z" />
  </Icon>
);

export const PinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 2h6a1 1 0 0 1 .3 1.95l-.8.27.7 5.2 2.4 2.4A1 1 0 0 1 16.9 13.5H13v7a1 1 0 1 1-2 0v-7H7.1a1 1 0 0 1-.7-1.7l2.4-2.4.7-5.2-.8-.27A1 1 0 0 1 9 2Z" />
  </Icon>
);

export const PeopleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.5c-3.6 0-6.5 1.9-6.5 4.2V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-2.3c0-2.3-2.9-4.2-6.5-4.2Zm7.6-1.6a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Zm.4 1.6c-.7 0-1.4.1-2 .3 1.5 1 2.5 2.5 2.5 4.2V20h3.5a1 1 0 0 0 1-1v-2c0-2.1-2.2-3.5-5-3.5Z" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.5 2h5a1 1 0 0 1 1 1v1H20a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2h4.5V3a1 1 0 0 1 1-1Zm-3.4 6h11.8l-.8 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6.1 8Zm3.4 3a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1Zm5 0a1 1 0 0 0-1 1v6a1 1 0 1 0 2 0v-6a1 1 0 0 0-1-1Z" />
  </Icon>
);

/**
 * A marca vem do PNG da arte, não de um SVG redesenhado: é a mesma imagem que o
 * ícone do app e do PWA usam, então a identidade não se divide em duas versões.
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src={size > 128 ? "/brand/logo-512.png" : "/brand/logo-256.png"}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}
