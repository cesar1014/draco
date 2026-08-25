import { useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { SpeakerIcon, SpeakerOffIcon } from "@/components/Icons";
import { useDismiss } from "@/hooks/useDismiss";
import { statsGrade } from "@/rtc/stats";
import { MAX_PERSON_VOLUME, prefsFor, useStore } from "@/state/store";
import type { Member } from "@/types";

/**
 * Volume e mute de uma pessoa só, pra quem está ouvindo. Nada disso viaja pela
 * rede: é o `<audio>` local que muda, então a outra pessoa não fica sabendo.
 */
export function PersonMenu({ member, onClose }: { member: Member; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const people = useStore((state) => state.people);
  const stats = useStore((state) => state.stats[member.id]);
  const showStats = useStore((state) => state.settings.showStats);
  const setPersonVolume = useStore((state) => state.setPersonVolume);
  const togglePersonMuted = useStore((state) => state.togglePersonMuted);
  const resetPerson = useStore((state) => state.resetPerson);

  useDismiss(box, onClose);

  const prefs = prefsFor(people, member.username);
  const percent = Math.round(prefs.volume * 100);
  const boosted = percent > 100;

  return (
    <div className="person-menu" ref={box} role="dialog" aria-label={`Áudio de ${member.username}`}>
      <header>
        <Avatar member={member} size={36} />
        <div>
          <strong>{member.username}</strong>
          <em data-boost={boosted}>
            {prefs.muted ? "Silenciado para você" : `Volume ${percent}%`}
          </em>
        </div>
      </header>

      <label className="person-volume">
        <span>Volume{boosted ? " · reforçado" : ""}</span>
        <input
          type="range"
          className="range-boost"
          min={0}
          max={MAX_PERSON_VOLUME * 100}
          step={5}
          value={percent}
          disabled={prefs.muted}
          onChange={(event) => setPersonVolume(member.username, Number(event.target.value) / 100)}
        />
      </label>

      <div className="person-actions">
        <button
          type="button"
          className="person-button"
          data-on={prefs.muted}
          onClick={() => togglePersonMuted(member.username)}
        >
          {prefs.muted ? <SpeakerOffIcon size={16} /> : <SpeakerIcon size={16} />}
          {prefs.muted ? "Ouvir de novo" : "Silenciar para mim"}
        </button>
        <button
          type="button"
          className="person-button"
          onClick={() => resetPerson(member.username)}
          disabled={!prefs.muted && percent === 100}
        >
          Padrão
        </button>
      </div>

      {showStats && (
        <ul className="person-stats" data-grade={statsGrade(stats)}>
          <li>
            <span>Recebendo</span>
            <b>{stats ? `${stats.down} kb/s` : "—"}</b>
          </li>
          <li>
            <span>Latência</span>
            <b>{stats?.rtt != null ? `${stats.rtt} ms` : "—"}</b>
          </li>
          <li>
            <span>Perda</span>
            <b>{stats ? `${stats.loss}%` : "—"}</b>
          </li>
          {stats?.height ? (
            <li>
              <span>Vídeo</span>
              <b>
                {stats.width}×{stats.height} · {stats.fps} fps
              </b>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
