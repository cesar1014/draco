import type { SVGProps } from "react";

/**
 * Ícones em SVG inline, desenhados no mesmo grid de 24 px do Discord.
 *
 * Não entra biblioteca de ícones aqui: são doze desenhos, e cada um custa menos
 * que a dependência custaria. Todos herdam a cor do texto (`currentColor`), então
 * quem muda a aparência é o CSS do botão, não uma prop.
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

/** Risco diagonal dos ícones "desligado", igual ao do app. */
const Slash = () => (
  <path d="M3.3 2 22 20.7l-1.4 1.4L1.9 3.4 3.3 2Z" stroke="#1e1f22" strokeWidth="1.2" />
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

export const ExpandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18.4 4.2 12 10.6 5.6 4.2 4.2 5.6 10.6 12l-6.4 6.4 1.4 1.4L12 13.4l6.4 6.4 1.4-1.4L13.4 12l6.4-6.4-1.4-1.4Z" />
  </Icon>
);

export const DiscordIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M19.3 5.4A16 16 0 0 0 15.4 4l-.3.6a12 12 0 0 1 3.5 1.8 16.7 16.7 0 0 0-10.6-.6L7.6 4a16 16 0 0 0-4 1.4C1.4 9.2.7 12.9 1 16.6a16.2 16.2 0 0 0 4.9 2.5l.7-1.1a10.4 10.4 0 0 1-1.8-.9l.4-.3a11.6 11.6 0 0 0 9.9 0l.4.3c-.5.4-1.1.7-1.8.9l.7 1.1a16.2 16.2 0 0 0 4.9-2.5c.4-4.2-.7-7.9-2.9-11.2ZM8.5 14.3c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
  </Icon>
);
