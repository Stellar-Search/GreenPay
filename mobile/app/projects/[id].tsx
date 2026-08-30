/**
 * app/projects/[id].tsx
 * Project detail screen
 */
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { apiFetch, apiGet, parseApiFetchResponse } from '../../utils/api';
import { getPushToken, followProject, unfollowProject } from '../../utils/notifications';
import { parseProjectUpdates, type MobileProjectUpdate } from '../../utils/projectUpdates';
import { useTheme } from '../theme';

interface ClimateProject {
  id: string;
  name: string;
  description: string;
  category: string;
  location: string;
  imageUrl?: string;
  goalXLM: string;
  raisedXLM: string;
  donorCount: number;
  co2OffsetKg: number;
  walletAddress: string;
  status: string;
}

export default function ProjectDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const [project, setProject] = useState<ClimateProject | null>(null);
  const [projectUpdates, setProjectUpdates] = useState<MobileProjectUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [followLoading, setFollowLoading] = useState(false);

  useEffect(() => {
    if (id) {
      loadProject(id as string);
      initializeNotifications();
    }
  }, [id]);

  const initializeNotifications = async () => {
    try {
      const token = await getPushToken();
      if (token) {
        setPushToken(token);
        // Check if already following this project
        checkFollowStatus(id as string, token);
      }
    } catch (error) {
      console.error('Error initializing notifications:', error);
    }
  };

  const checkFollowStatus = async (projectId: string, token: string) => {
    try {
      const response = await apiFetch(`/api/notifications/follows?token=${encodeURIComponent(token)}`);
      const followedProjects = await parseApiFetchResponse<Array<{ id: string }>>(response);
      const isFollowed = followedProjects.some((p) => p.id === projectId);
      setIsFollowing(isFollowed);
    } catch (error) {
      console.error('Error checking follow status:', error);
    }
  };

  const loadProject = async (projectId: string) => {
    try {
      const [projectData, updatesData] = await Promise.all([
        apiGet<ClimateProject>(`/api/projects/${projectId}`),
        apiGet<unknown>(`/api/updates/${projectId}`).catch(() => []),
      ]);
      setProject(projectData);
      setProjectUpdates(parseProjectUpdates(updatesData));
    } catch (error) {
      console.error('Error loading project:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleFollow = async () => {
    if (!pushToken || !project) return;

    setFollowLoading(true);
    try {
      if (isFollowing) {
        await unfollowProject(project.id, pushToken);
        setIsFollowing(false);
      } else {
        await followProject(project.id, pushToken);
        setIsFollowing(true);
      }
    } catch (error) {
      console.error('Error toggling follow:', error);
    } finally {
      setFollowLoading(false);
    }
  };

  const progressPercent = (raised: string, goal: string) => {
    const r = parseFloat(raised);
    const g = parseFloat(goal);
    if (!g || isNaN(r) || isNaN(g)) return 0;
    return Math.min(100, Math.round((r / g) * 100));
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}> 
        <Text style={[styles.loadingText, { color: colors.secondaryText }]}>Loading project...</Text>
      </View>
    );
  }

  if (!project) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}> 
        <Text style={[styles.errorText, { color: colors.secondaryText }]}>Project not found</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}> 
      <View style={[styles.header, { backgroundColor: colors.primary }]}> 
        <Text style={[styles.category, { color: colors.headerText }]}>{project.category}</Text>
        <Text style={[styles.name, { color: colors.headerText }]}>{project.name}</Text>
        <Text style={[styles.location, { color: colors.headerText }]}>📍 {project.location}</Text>
      </View>

      <View style={[styles.statsCard, { backgroundColor: colors.surface, shadowColor: colors.cardShadow, borderColor: colors.cardBorder }]}> 
        <View style={styles.statRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.accent }]}>{parseFloat(project.raisedXLM).toFixed(2)}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>XLM Raised</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.accent }]}>{project.donorCount}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Donors</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.accent }]}>{project.co2OffsetKg.toFixed(0)}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>kg CO₂</Text>
          </View>
        </View>
      </View>

      <View style={[styles.progressCard, { backgroundColor: colors.surface, shadowColor: colors.cardShadow, borderColor: colors.cardBorder }]}> 
        <Text style={[styles.progressTitle, { color: colors.primaryText }]}>Fundraising Progress</Text>
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}> 
          <View
            style={[
              styles.progressFill,
              { width: `${progressPercent(project.raisedXLM, project.goalXLM)}%`, backgroundColor: colors.primary }
            ]}
          />
        </View>
        <Text style={[styles.progressText, { color: colors.secondaryText }]}> 
          {progressPercent(project.raisedXLM, project.goalXLM)}% complete
        </Text>
        <Text style={[styles.goalText, { color: colors.muted }]}> 
          Goal: {parseFloat(project.goalXLM).toFixed(2)} XLM
        </Text>
      </View>

      <View style={[styles.descriptionCard, { backgroundColor: colors.surface, shadowColor: colors.cardShadow, borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>About this project</Text>
        <Text style={[styles.description, { color: colors.secondaryText }]}>{project.description}</Text>
      </View>

      <View style={[styles.descriptionCard, { backgroundColor: colors.surface, shadowColor: colors.cardShadow, borderColor: colors.cardBorder }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Project updates</Text>
        {projectUpdates.length === 0 ? (
          <Text style={[styles.description, { color: colors.secondaryText }]}>No published updates yet.</Text>
        ) : projectUpdates.map((update) => (
          <View key={update.id} style={styles.updateItem}>
            <Text style={[styles.updateTitle, { color: colors.primaryText }]}>{update.title}</Text>
            <Text style={[styles.description, { color: colors.secondaryText }]}>{update.body}</Text>
          </View>
        ))}
      </View>

      {pushToken && (
        <TouchableOpacity
          style={[styles.followButton, isFollowing && styles.followButtonActive]}
          onPress={handleToggleFollow}
          disabled={followLoading}
        >
          <Text style={styles.followButtonText}>
            {followLoading ? 'Loading...' : isFollowing ? '🔔 Following' : '🔔 Follow for Updates'}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.donateButton, { backgroundColor: colors.buttonBackground }]}
        onPress={() => router.push(`/donate/${project.id}`)}
      >
        <Text style={[styles.donateButtonText, { color: colors.buttonText }]}>🌱 Donate Now</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.monthlyButton, { borderColor: colors.primary }]}
        onPress={() => router.push(`/donate/${project.id}`)}
        accessibilityLabel="Set up monthly donation"
      >
        <Text style={[styles.monthlyButtonText, { color: colors.primary }]}>
          📅 Set up monthly giving
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingText: {
    fontSize: 18,
    textAlign: 'center',
    marginTop: 40,
  },
  errorText: {
    fontSize: 18,
    textAlign: 'center',
    marginTop: 40,
  },
  header: {
    padding: 24,
  },
  category: {
    fontSize: 14,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    marginTop: 8,
  },
  location: {
    fontSize: 14,
    marginTop: 4,
  },
  statsCard: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  progressCard: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
  },
  progressTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  progressBar: {
    height: 12,
    borderRadius: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
  progressText: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  goalText: {
    fontSize: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  descriptionCard: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
  },
  updateItem: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#c8d8c8',
  },
  updateTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  followButton: {
    backgroundColor: '#fff',
    padding: 16,
    margin: 16,
    marginTop: 0,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#227239',
  },
  followButtonActive: {
    backgroundColor: '#227239',
  },
  followButtonText: {
    color: '#227239',
    fontSize: 16,
    fontWeight: 'bold',
  },
  donateButton: {
    padding: 16,
    margin: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  donateButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  monthlyButton: {
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 28,
    marginTop: 0,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 2,
    backgroundColor: 'transparent',
  },
  monthlyButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
