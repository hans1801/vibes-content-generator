import { useState } from 'react';
import { SUPPORTED_SITES } from '../../../../lib/constants';

const PROMPT_TEXT = `Convert the provided video script into the following JSON structure.

For each scene, generate: scene_number, image_prompt, video_prompt, narration.

Requirements:

* image_prompt / video_prompt: exact content from the "Image Prompt" / "Video Prompt" sections, as a single plain text string — no markdown, bullet points, bold, headers, or line breaks.
* narration: exact content from the "Narration" section, in its original language.
* Do not rewrite, improve, summarize, embellish, or reinterpret any scene — preserve all details (descriptions, actions, lighting, composition, atmosphere, style, duration).
* Keep prompts in their original language.
* Return only valid JSON, no nested objects, no omitted scenes — one entry per scene found in the script.

Output format:

{
  "scenes": [
    {
      "scene_number": 1,
      "image_prompt": "...",
      "video_prompt": "...",
      "narration": "..."
    }
  ]
}`;

// Onboarding / "how to use" screen — static walkthrough of the script.json
// format and the 5-step workflow, no batch state involved.
export function HowToUseMode() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(PROMPT_TEXT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="main how-to-use">
      <div className="welcome-section">
        <p className="welcome-text">
          Este bot te permite automatizar la generación de imágenes y videos tanto en{' '}
          <a href={SUPPORTED_SITES[0].url} target="_blank" rel="noopener noreferrer">
            {SUPPORTED_SITES[0].name}
          </a>{' '}
          como en{' '}
          <a href={SUPPORTED_SITES[1].url} target="_blank" rel="noopener noreferrer">
            {SUPPORTED_SITES[1].name}
          </a>
          .
        </p>
      </div>

      <div className="steps-container">
        <div className="step-item">
          <div className="step-badge">1</div>
          <p className="step-text">Primero debes tener todas las escenas de tu guion preparadas.</p>
        </div>

        <div className="step-item">
          <div className="step-badge">2</div>
          <div className="step-content">
            <p className="step-text">
              Adapta tu guion al formato estructurado <code>script.json</code>. Si no lo tienes,
              copia y usa este prompt para generarlo con IA:
            </p>
            <div className="prompt-wrapper">
              <div className="prompt-container">
                <pre className="prompt-preview">{PROMPT_TEXT}</pre>
              </div>
              <button
                className={`icon-copy-btn ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
                title="Copiar prompt"
              >
                {copied ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">3</div>
          <div className="step-content">
            <p className="step-text">
              Guarda el archivo en una carpeta vacía. El archivo debe llamarse{' '}
              <strong>estrictamente</strong> <code>script.json</code>. Estructura inicial:
            </p>
            <div className="folder-structure">
              📁 Mi-Proyecto-AI/
              <br />
              └── 📄 script.json
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">4</div>
          <div className="step-content">
            <p className="step-text">
              <strong>Paso 4:</strong> Configura y genera las imágenes de tu proyecto.
            </p>

            <details className="step-details" style={{ marginTop: '4px' }}>
              <summary>Configuración de plataforma (Vibes AI / Google Flow)</summary>
              <div className="details-content">
                <div className="platform-option vibes">
                  <h4>🟣 Vibes AI (Gratis)</h4>
                  <ul>
                    <li>📝 Nota: La plataforma puede ser inestable.</li>
                    <li>
                      🚀 No requiere configuración previa, solo haz clic en Generar en la extensión.
                    </li>
                  </ul>
                </div>

                <div className="platform-option flow">
                  <h4>🔵 Google Flow (Gratis - 0 puntos)</h4>
                  <ul>
                    <li>✅ Más estable (0 puntos).</li>
                    <li>
                      ⚙️ Activa el modo <strong>Agente</strong> y selecciona <strong>x2</strong> en
                      la web antes de generar:
                    </li>
                  </ul>
                  <img
                    src="/flow_image.png"
                    alt="Configuración Imagen Flow"
                    className="guide-img"
                  />
                </div>
              </div>
            </details>

            <div className="sub-step-info" style={{ marginTop: '8px' }}>
              <p className="step-text">
                En la pestaña <strong>Proyecto</strong>, selecciona tu carpeta, asegúrate de estar
                en el modo <strong>Imágenes</strong> y haz clic en <strong>Generar imágenes</strong>
                :
              </p>
              <img
                src="/ext_image_project.png"
                alt="Generar imágenes en extensión"
                className="screenshot-img"
              />
            </div>

            <div className="sub-step-info" style={{ marginTop: '8px' }}>
              <p className="step-text">
                El bot creará automáticamente la subcarpeta <code>images</code> y guardará las
                imágenes:
              </p>
              <div className="folder-structure" style={{ marginTop: '4px' }}>
                📁 Mi-Proyecto-AI/
                <br />
                ├── 📁 images/
                <br />
                └── 📄 script.json
              </div>
            </div>
          </div>
        </div>

        <div className="step-item">
          <div className="step-badge">5</div>
          <div className="step-content">
            <p className="step-text">
              <strong>Paso 5:</strong> Configura y genera los videos de tu proyecto.
            </p>

            <details className="step-details" style={{ marginTop: '4px' }}>
              <summary>Configuración de plataforma (Vibes AI / Google Flow)</summary>
              <div className="details-content">
                <div className="platform-option vibes">
                  <h4>🟣 Vibes AI (Gratis)</h4>
                  <ul>
                    <li>📝 Nota: La plataforma puede ser inestable.</li>
                    <li>
                      🚀 No requiere configuración previa, solo haz clic en Generar en la extensión.
                    </li>
                  </ul>
                </div>

                <div className="platform-option flow">
                  <h4>🔵 Google Flow (10 puntos por video)</h4>
                  <ul>
                    <li>💰 Cuesta 10 puntos por video.</li>
                    <li>
                      ⚙️ Cambia el agente a modo <strong>Vídeo</strong> y selecciona{' '}
                      <strong>x1</strong> en la web antes de generar:
                    </li>
                  </ul>
                  <img src="/flow_video.png" alt="Configuración Video Flow" className="guide-img" />
                </div>
              </div>
            </details>

            <div className="sub-step-info" style={{ marginTop: '8px' }}>
              <p className="step-text">
                En la extensión, selecciona el sub-modo <strong>Videos</strong> y haz clic en{' '}
                <strong>Generar videos</strong>:
              </p>
              <img
                src="/ext_video_project.png"
                alt="Generar videos en extensión"
                className="screenshot-img"
              />
            </div>

            <div className="sub-step-info" style={{ marginTop: '8px' }}>
              <p className="step-text">
                El bot creará la subcarpeta <code>videos</code>, completando la estructura final:
              </p>
              <div className="folder-structure" style={{ marginTop: '4px' }}>
                📁 Mi-Proyecto-AI/
                <br />
                ├── 📁 images/
                <br />
                ├── 📁 videos/
                <br />
                └── 📄 script.json
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="channel-section">
        <p className="channel-text">
          Encuentra más automatizaciones y desarrollo en mi canal:{' '}
          <a href="https://www.youtube.com/@Hans-Acha" target="_blank" rel="noopener noreferrer">
            YouTube @Hans-Acha
          </a>
        </p>
      </div>
    </div>
  );
}
