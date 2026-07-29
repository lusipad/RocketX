import EfficiencySection from './EfficiencySection';
import ProfileSection from './ProfileSection';
import WorkAnalysisSection from './WorkAnalysisSection';

export function ProfilePanel() {
  return <ProfileSection />;
}

export function AnalysisPanel() {
  return (
    <div className="space-y-9">
      <WorkAnalysisSection />
      <EfficiencySection />
    </div>
  );
}

export default function LearningPanel() {
  return (
    <div className="space-y-9">
      <ProfilePanel />
      <AnalysisPanel />
    </div>
  );
}
