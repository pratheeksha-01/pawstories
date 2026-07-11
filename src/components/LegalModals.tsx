import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivacyModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 p-6 sm:p-8 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto relative shadow-2xl">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-white bg-zinc-800 p-2 rounded-full transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        
        <div className="prose prose-invert prose-zinc max-w-none">
          <h1 className="text-2xl font-black text-white mb-6 uppercase tracking-tight">Privacy Policy</h1>
          <p className="text-zinc-300 text-sm mb-4">
            This Privacy Policy explains how PawStories (we), operating pawstories.fun, collects, uses, shares, and protects your information when you use our AI-powered pet persona generator (the "Service").
          </p>
          
          <h2 className="text-lg font-bold text-white mt-6 mb-2">1. Information We Collect</h2>
          <p className="text-zinc-300 text-sm mb-2"><strong>a) Photos you upload</strong><br/>
          When you use PawStories, you upload photos of your pet. These photos are processed to generate a stylized persona or poster.</p>
          <p className="text-zinc-300 text-sm mb-2"><strong>b) Information you provide</strong><br/>
          If you contact us, sign up for updates, or create an account (if offered), we may collect your name, email address, or other details you choose to share.</p>
          <p className="text-zinc-300 text-sm mb-2"><strong>c) Automatically collected information</strong><br/>
          Like most websites, we may automatically collect:
          <ul className="list-disc pl-5 mt-1 mb-2">
            <li>Device and browser type</li>
            <li>IP address (approximate location)</li>
            <li>Pages visited and time spent on the Service</li>
            <li>Referring website</li>
          </ul>
          This may be collected via cookies or similar technologies, or via analytics tools (e.g., Google Analytics), if in use.</p>
          
          <h2 className="text-lg font-bold text-white mt-6 mb-2">2. How We Use Your Information</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We use your information to:
            <ul className="list-disc pl-5 mt-1 mb-2">
              <li>Generate your pet's AI persona/poster</li>
              <li>Operate, maintain, and improve the Service</li>
              <li>Respond to your inquiries or support requests</li>
              <li>Understand usage patterns to improve the product</li>
              <li>Communicate updates, if you've opted in</li>
            </ul>
            We do <strong>not</strong> sell your personal information or uploaded photos to third parties for advertising purposes.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">3. Third-Party AI Processing</h2>
          <p className="text-zinc-300 text-sm mb-2">
            To generate personas, your uploaded photos are sent to <strong>Google's Gemini API</strong> (or other AI providers we may use) for processing. This means:
            <ul className="list-disc pl-5 mt-1 mb-2">
              <li>Your photo is transmitted to Google's servers for the purpose of generating your persona</li>
              <li>Google's own privacy policy and data handling practices apply to this processing, in addition to ours</li>
              <li>We do not control how long third-party AI providers may retain data for abuse-monitoring or safety purposes under their own policies; we encourage you to review Google's API/Gemini terms directly for specifics</li>
            </ul>
            We recommend not uploading photos containing sensitive personal information beyond your pet (e.g., avoid photos that clearly reveal your home address, other people's faces, or similarly identifying details) unless you're comfortable with that content being processed by our AI provider.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">4. Data Retention</h2>
          <ul className="list-disc pl-5 mt-1 mb-2 text-zinc-300 text-sm">
            <li>Uploaded photos are retained only as long as necessary to generate your persona/poster and for a short period afterward for troubleshooting purposes, after which they are deleted, unless you've explicitly asked us to retain them (e.g., in a saved gallery feature, if offered).</li>
            <li>We may retain generated outputs if you choose to save them to an account.</li>
            <li>Contact/support information is retained as long as needed to respond to and document your inquiry.</li>
          </ul>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">5. Your Rights</h2>
          <p className="text-zinc-300 text-sm mb-2">
            Depending on your location, you may have rights to:
            <ul className="list-disc pl-5 mt-1 mb-2">
              <li>Access the personal data we hold about you</li>
              <li>Request correction or deletion of your data</li>
              <li>Withdraw consent for processing</li>
              <li>Object to certain uses of your data</li>
            </ul>
            To exercise these rights, contact us at <strong><a href="mailto:hello@pawstories.fun" className="text-blue-400 hover:underline">hello@pawstories.fun</a></strong>. We'll respond within a reasonable timeframe.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">6. Children's Privacy</h2>
          <p className="text-zinc-300 text-sm mb-2">
            PawStories is not directed at children under 18. We do not knowingly collect personal information from children. If you believe a child has provided us with personal information, please contact us so we can delete it.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">7. Data Security</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We take reasonable technical and organizational measures to protect your data. However, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">8. Cookies</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We may use cookies or similar technologies to keep the Service functional and to understand usage. You can control cookies through your browser settings; disabling them may affect some features of the Service.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">9. International Data Transfers</h2>
          <p className="text-zinc-300 text-sm mb-2">
            Since we use third-party AI providers (e.g., Google), your data may be processed on servers located outside India. By using the Service, you consent to this transfer.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">10. Changes to This Policy</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We may update this Privacy Policy from time to time. Continued use of the Service after updates constitutes acceptance of the revised policy.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">11. Contact Us</h2>
          <p className="text-zinc-300 text-sm mb-2">
            For any privacy-related questions or requests, contact us at: <a href="mailto:hello@pawstories.fun" className="text-blue-400 hover:underline">hello@pawstories.fun</a>
          </p>
        </div>
      </div>
    </div>
  );
};

export const TermsModal: React.FC<ModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 p-6 sm:p-8 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto relative shadow-2xl">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-white bg-zinc-800 p-2 rounded-full transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        
        <div className="prose prose-invert prose-zinc max-w-none">
          <h1 className="text-2xl font-black text-white mb-6 uppercase tracking-tight">Terms of Service</h1>
          <p className="text-zinc-300 text-sm mb-4">
            Welcome to PawStories (accessible at pawstories.fun). These Terms of Service ("Terms") govern your access to and use of our website and services, including our AI-powered pet persona generator (the "Service"). By using PawStories, you agree to these Terms. If you do not agree, please do not use the Service.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">1. What PawStories Does</h2>
          <p className="text-zinc-300 text-sm mb-2">
            PawStories lets you upload photos of your pet and uses artificial intelligence (including third-party AI models such as Google's Gemini API) to generate a stylized "persona" or shareable poster based on your pet's image. Generated content is provided for entertainment purposes.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">2. Eligibility</h2>
          <p className="text-zinc-300 text-sm mb-2">
            You must be at least 18 years old, or the age of legal majority in your jurisdiction, to use PawStories. If you are under 18, you may use the Service only with the involvement and consent of a parent or guardian.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">3. Your Content</h2>
          <ul className="list-disc pl-5 mt-1 mb-2 text-zinc-300 text-sm">
            <li><strong>Ownership:</strong> You retain ownership of the photos you upload ("Your Content"). By uploading, you grant PawStories a limited, non-exclusive, royalty-free license to process Your Content solely to provide the Service (e.g., sending it to our AI processing partners and generating your persona/poster).</li>
            <li><strong>Your responsibility:</strong> You confirm that you own the photos you upload, or have the right to upload and use them, and that they don't infringe anyone else's rights (including a photo of someone else's pet without permission).</li>
            <li><strong>Prohibited uploads:</strong> Do not upload images that are illegal, harmful, abusive, sexually explicit, contain identifiable people without consent, or that you don't have rights to use.</li>
          </ul>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">4. Generated Content</h2>
          <ul className="list-disc pl-5 mt-1 mb-2 text-zinc-300 text-sm">
            <li>Personas and posters generated by our Service are AI-generated and may not always be accurate, tasteful, or free of unexpected results, since AI outputs can be unpredictable.</li>
            <li>You're free to download, share, and use content generated from your own uploaded photos for personal, non-commercial purposes, unless we state otherwise.</li>
            <li>We do not guarantee that generated content will be unique or that similar outputs won't be generated for other users.</li>
          </ul>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">5. Third-Party AI Processing</h2>
          <p className="text-zinc-300 text-sm mb-2">
            To generate personas, uploaded photos are sent to third-party AI providers (currently Google's Gemini API) for processing. Your use of the Service constitutes consent to this transfer. These third parties process the data under their own terms and privacy practices, in addition to ours — see our Privacy Policy for details.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">6. Acceptable Use</h2>
          <p className="text-zinc-300 text-sm mb-2">
            You agree not to:
            <ul className="list-disc pl-5 mt-1 mb-2">
              <li>Use the Service for any unlawful purpose</li>
              <li>Attempt to reverse-engineer, scrape, or disrupt the Service</li>
              <li>Upload malicious files or attempt to compromise our systems</li>
              <li>Use the Service to harass, defame, or harm any person or animal</li>
              <li>Misrepresent generated content as professional veterinary, medical, or behavioral advice</li>
            </ul>
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">7. No Professional Advice</h2>
          <p className="text-zinc-300 text-sm mb-2">
            PawStories is for entertainment purposes only. Nothing on the Service constitutes veterinary, medical, or behavioral advice for your pet. Always consult a qualified veterinarian for your pet's health and wellbeing.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">8. Intellectual Property</h2>
          <p className="text-zinc-300 text-sm mb-2">
            All PawStories branding, website design, and underlying technology (excluding Your Content and AI-generated outputs) are owned by PawStories and protected by applicable intellectual property laws.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">9. Disclaimers</h2>
          <p className="text-zinc-300 text-sm mb-2">
            The Service is provided "as is" and "as available," without warranties of any kind, whether express or implied. We do not warrant that the Service will be uninterrupted, error-free, or that AI-generated results will meet your expectations.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">10. Limitation of Liability</h2>
          <p className="text-zinc-300 text-sm mb-2">
            To the maximum extent permitted by law, PawStories and its founders/operators shall not be liable for any indirect, incidental, special, or consequential damages arising out of your use of, or inability to use, the Service.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">11. Termination</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We may suspend or terminate your access to the Service at any time, with or without notice, if we believe you've violated these Terms.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">12. Changes to These Terms</h2>
          <p className="text-zinc-300 text-sm mb-2">
            We may update these Terms from time to time. Continued use of the Service after changes take effect constitutes acceptance of the revised Terms.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">13. Governing Law</h2>
          <p className="text-zinc-300 text-sm mb-2">
            These Terms are governed by the laws of India, without regard to conflict of law principles. Any disputes will be subject to the exclusive jurisdiction of the courts in Bengaluru, Karnataka.
          </p>

          <h2 className="text-lg font-bold text-white mt-6 mb-2">14. Contact Us</h2>
          <p className="text-zinc-300 text-sm mb-2">
            If you have questions about these Terms, contact us at: <a href="mailto:hello@pawstories.fun" className="text-blue-400 hover:underline">hello@pawstories.fun</a>
          </p>
        </div>
      </div>
    </div>
  );
};
