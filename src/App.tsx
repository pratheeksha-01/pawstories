import PetGeneratorApp from './features/pet-generator/PetGeneratorApp';
import AdminDashboard from './features/admin/AdminDashboard';

// No router library in this app — one extra static path doesn't need one.
export default function App() {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
    return <AdminDashboard />;
  }
  return <PetGeneratorApp />;
}
