import prisma from '../config/database';
import { logger } from '../utils/logger';

interface QuizQuestion {
  q: string;
  options: string[];
  answer: number; // index of correct option
}

const DEFAULT_BADGES = [
  {
    slug: 'luxury_car',
    title: 'Luxury Car Certified',
    description: 'Expert in driving luxury vehicles with premium care and attention to detail.',
    icon: 'car-sports',
    color: '#C9A84C',
    category: 'VEHICLE',
    sortOrder: 1,
    quiz: {
      title: 'Luxury Car Handling Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'What should you check before starting a luxury car?', options: ['Seat adjustment only', 'All mirrors, seat, and steering position', 'Just the fuel level', 'Nothing specific'], answer: 1 },
        { q: 'How should you handle a luxury car on speed breakers?', options: ['Drive fast over them', 'Slow down significantly to protect suspension', 'Same as any other car', 'Honk and go'], answer: 1 },
        { q: 'What is the correct parking etiquette for luxury cars?', options: ['Park anywhere', 'Park in shade, away from other cars when possible', 'Double park to save time', 'Park on the road'], answer: 1 },
        { q: 'How do you maintain the interior of a luxury vehicle?', options: ['Eat food inside freely', 'Keep AC running and avoid touching leather with dirty hands', 'Let passengers do whatever', 'Spray air freshener heavily'], answer: 1 },
        { q: 'What should you do if a luxury car makes an unusual noise?', options: ['Ignore it', 'Report to customer immediately and suggest service', 'Turn up the music', 'Keep driving'], answer: 1 },
      ] as QuizQuestion[],
    },
  },
  {
    slug: 'long_distance',
    title: 'Long Distance Expert',
    description: 'Skilled in long-distance driving with proper rest and fuel management.',
    icon: 'road-variant',
    color: '#3b82f6',
    category: 'ROUTE',
    sortOrder: 2,
    quiz: {
      title: 'Long Distance Driving Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'How often should you take a break on long drives?', options: ['Never', 'Every 2-3 hours', 'Every 8 hours', 'Only when fuel runs out'], answer: 1 },
        { q: 'What should you check before a long trip?', options: ['Tyre pressure, oil, coolant, and fuel', 'Just fuel level', 'Music playlist', 'Nothing'], answer: 0 },
        { q: 'What do you do if you feel drowsy while driving?', options: ['Open the window and keep driving', 'Stop and rest immediately', 'Drink coffee and continue', 'Drive faster to reach sooner'], answer: 1 },
        { q: 'What is the safest lane for highway driving?', options: ['Leftmost lane', 'Middle lane for steady pace', 'Rightmost lane always', 'Keep switching lanes'], answer: 1 },
        { q: 'How should you handle toll booths efficiently?', options: ['Skip them', 'Keep FASTag ready and slow down in queue', 'Honk at the car in front', 'Use cash always'], answer: 1 },
      ] as QuizQuestion[],
    },
  },
  {
    slug: 'airport_specialist',
    title: 'Airport Specialist',
    description: 'Expert in airport pickups and drops with knowledge of terminals and timing.',
    icon: 'airplane',
    color: '#8b5cf6',
    category: 'ROUTE',
    sortOrder: 3,
    quiz: {
      title: 'Airport Transfer Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'How early should you arrive for an airport pickup?', options: ['Exactly on time', '10-15 minutes early', '1 hour early', 'After the flight lands'], answer: 1 },
        { q: 'Where should you wait for passengers at the airport?', options: ['On the runway', 'In the designated pickup zone', 'On the highway', 'At a nearby restaurant'], answer: 1 },
        { q: 'What should you do if the flight is delayed?', options: ['Leave immediately', 'Wait and track flight status', 'Call passenger repeatedly', 'Charge extra'], answer: 1 },
        { q: 'How do you handle passenger luggage?', options: ['Let them handle it', 'Help load and unload carefully', 'Ignore luggage', 'Throw it in the trunk'], answer: 1 },
        { q: 'What is important to know about airport terminals?', options: ['Nothing', 'Terminal locations, pickup/drop zones, and restricted areas', 'Only parking areas', 'Where to eat'], answer: 1 },
      ] as QuizQuestion[],
    },
  },
  {
    slug: 'ev_ready',
    title: 'EV Ready',
    description: 'Certified to drive electric vehicles with charging and range management skills.',
    icon: 'ev-station',
    color: '#10b981',
    category: 'VEHICLE',
    sortOrder: 4,
    quiz: {
      title: 'Electric Vehicle Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'How does regenerative braking work in EVs?', options: ['It makes the car faster', 'Converts kinetic energy back to battery charge when decelerating', 'It uses more battery', 'Same as normal braking'], answer: 1 },
        { q: 'What range should you plan to keep as buffer in an EV?', options: ['0%', 'At least 15-20%', '100%', '1%'], answer: 1 },
        { q: 'How should you drive an EV to maximize range?', options: ['Drive aggressively', 'Smooth acceleration, use eco mode, plan charging stops', 'Always use sport mode', 'Keep AC on max'], answer: 1 },
        { q: 'What type of charger is fastest for EVs?', options: ['Home socket', 'DC fast charger', 'USB cable', 'Solar only'], answer: 1 },
        { q: 'What should you tell the customer about EV range?', options: ['Nothing', 'Current battery level, estimated range, and nearest charging station', 'The car is always full', 'It will run forever'], answer: 1 },
      ] as QuizQuestion[],
    },
  },
  {
    slug: 'night_driving',
    title: 'Night Driving Pro',
    description: 'Expert in safe night driving with proper visibility and alertness techniques.',
    icon: 'weather-night',
    color: '#6366f1',
    category: 'SKILL',
    sortOrder: 5,
    quiz: {
      title: 'Night Driving Safety Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'When should you use high beam headlights?', options: ['Always', 'Only on empty roads with no oncoming traffic', 'Never', 'In the city'], answer: 1 },
        { q: 'What should you do if blinded by oncoming headlights?', options: ['Flash back at them', 'Look at the left edge of the road and slow down', 'Close your eyes', 'Speed up'], answer: 1 },
        { q: 'How do you manage fatigue during night driving?', options: ['Energy drinks only', 'Regular breaks, proper rest before trip, light snacks', 'Keep driving', 'Roll down windows'], answer: 1 },
        { q: 'What is the safe following distance at night?', options: ['Same as day', 'Increased — at least 4 seconds gap', 'Tailgate them', 'No gap needed'], answer: 1 },
        { q: 'What should you check before a night trip?', options: ['Just fuel', 'All lights (headlights, brake lights, indicators, fog lights)', 'Nothing', 'Music system'], answer: 1 },
      ] as QuizQuestion[],
    },
  },
  {
    slug: 'highway_expert',
    title: 'Highway Expert',
    description: 'Certified for highway and expressway driving with lane discipline and overtaking skills.',
    icon: 'highway',
    color: '#f59e0b',
    category: 'ROUTE',
    sortOrder: 6,
    quiz: {
      title: 'Highway Driving Quiz',
      passingScore: 70,
      timeLimitSec: 300,
      questions: [
        { q: 'What is proper lane discipline on a 4-lane highway?', options: ['Drive in any lane', 'Stay on the left, overtake from right', 'Always drive on the right', 'Keep switching'], answer: 1 },
        { q: 'How should you overtake on a highway?', options: ['From the left side', 'Signal, check mirrors, overtake from the right safely', 'Honk and push through', 'Flash lights continuously'], answer: 1 },
        { q: 'What do you do if your tyre bursts on a highway?', options: ['Brake hard', 'Hold steering firmly, slowly decelerate, move to shoulder', 'Jump out', 'Accelerate'], answer: 1 },
        { q: 'What is the speed limit typically on Indian expressways?', options: ['200 kmph', '80-120 kmph depending on the expressway', '40 kmph', 'No limit'], answer: 1 },
        { q: 'How do you handle fog on a highway?', options: ['Turn on hazard lights, slow down, use low beam', 'Drive normally', 'Use high beam', 'Stop in the middle of the road'], answer: 0 },
      ] as QuizQuestion[],
    },
  },
];

export class BadgeService {
  /**
   * Seed default badge definitions if they don't exist.
   */
  static async seedDefaultBadges() {
    for (const badge of DEFAULT_BADGES) {
      const existing = await prisma.badgeDefinition.findUnique({ where: { slug: badge.slug } });
      if (existing) continue;

      logger.info(`Seeding badge: ${badge.title}`);
      await prisma.badgeDefinition.create({
        data: {
          slug: badge.slug,
          title: badge.title,
          description: badge.description,
          icon: badge.icon,
          color: badge.color,
          category: badge.category,
          sortOrder: badge.sortOrder,
          quiz: {
            create: {
              title: badge.quiz.title,
              questions: badge.quiz.questions as any,
              passingScore: badge.quiz.passingScore,
              timeLimitSec: badge.quiz.timeLimitSec,
            },
          },
        },
      });
    }
  }

  /**
   * List all active badge definitions with quiz availability.
   */
  static async getAllBadges() {
    return prisma.badgeDefinition.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        quiz: { select: { id: true, title: true, passingScore: true, timeLimitSec: true } },
      },
    });
  }

  /**
   * Get badges earned by a specific driver.
   */
  static async getDriverBadges(driverId: string) {
    return prisma.driverBadge.findMany({
      where: { driverId },
      include: {
        badge: { select: { slug: true, title: true, icon: true, color: true, category: true } },
      },
      orderBy: { earnedAt: 'desc' },
    });
  }

  /**
   * Get quiz questions for a badge (without correct answers).
   */
  static async getQuiz(badgeId: string) {
    const quiz = await prisma.badgeQuiz.findUnique({ where: { badgeId } });
    if (!quiz) throw new Error('No quiz found for this badge');

    const questions = (quiz.questions as unknown as QuizQuestion[]).map(q => ({
      q: q.q,
      options: q.options,
      // Don't send the answer!
    }));

    return {
      id: quiz.id,
      badgeId: quiz.badgeId,
      title: quiz.title,
      passingScore: quiz.passingScore,
      timeLimitSec: quiz.timeLimitSec,
      questions,
      totalQuestions: questions.length,
    };
  }

  /**
   * Submit quiz answers and award badge if passed.
   */
  static async submitQuiz(driverId: string, badgeId: string, answers: number[]) {
    // Check if already earned
    const alreadyEarned = await prisma.driverBadge.findUnique({
      where: { driverId_badgeId: { driverId, badgeId } },
    });
    if (alreadyEarned) throw new Error('Badge already earned');

    // Get quiz
    const quiz = await prisma.badgeQuiz.findUnique({ where: { badgeId } });
    if (!quiz) throw new Error('No quiz found for this badge');

    const questions = quiz.questions as unknown as QuizQuestion[];
    if (answers.length !== questions.length) {
      throw new Error(`Expected ${questions.length} answers, got ${answers.length}`);
    }

    // Grade
    let correct = 0;
    for (let i = 0; i < questions.length; i++) {
      if (answers[i] === questions[i].answer) correct++;
    }

    const score = Math.round((correct / questions.length) * 100);
    const passed = score >= quiz.passingScore;

    if (passed) {
      await prisma.driverBadge.create({
        data: { driverId, badgeId, quizScore: score },
      });
      logger.info('Badge awarded', { driverId, badgeId, score });
    }

    return {
      passed,
      score,
      correct,
      total: questions.length,
      passingScore: quiz.passingScore,
    };
  }
}
