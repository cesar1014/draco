import { useState } from "react";
import { runSelfTest, type TestResult } from "@/dev/selftest";

/**
 * Roda o autoteste do WebRTC a partir de um clique. O clique não é detalhe de
 * interface: o navegador mantém o áudio suspenso até haver gesto do usuário, e
 * sem áudio ativo o microfone sintético do teste não produziria som nenhum.
 */
export function SelfTestPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  async function start() {
    setResults([]);
    setDone(false);
    setRunning(true);
    try {
      await runSelfTest((result) => setResults((current) => [...current, result]));
    } finally {
      setRunning(false);
      setDone(true);
    }
  }

  const failed = results.filter((r) => !r.ok).length;

  return (
    <div className="selftest">
      <h1>Autoteste do WebRTC</h1>
      <p>
        Abre duas conexões nesta mesma aba, com microfone e câmera falsos, e verifica o núcleo da
        call: conexão, áudio trafegando nos dois sentidos, mute, câmera e tela em trilhas separadas
        e recuperação de rede. Leva cerca de 40 segundos.
      </p>

      <button type="button" onClick={start} disabled={running}>
        {running ? "Rodando…" : "Rodar teste"}
      </button>

      <ol>
        {results.map((result, index) => (
          <li key={`${result.label}-${index}`} data-ok={result.ok}>
            <span className="tag">{result.ok ? "PASS" : "FAIL"}</span>
            <span>{result.label}</span>
            {result.detail && <span className="detail">{result.detail}</span>}
          </li>
        ))}
      </ol>

      {done && (
        <p className="summary">
          {results.length - failed} passaram, {failed} falharam
        </p>
      )}
    </div>
  );
}
