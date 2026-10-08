export function topVoteSummary(history, options = []) {
  const members = new Map(options.map((option) => [option.id, {
    id: option.id, name: option.name, totalVotes: 0, questions: [], outright: 0, tied: 0,
  }]));
  history.forEach((result, index) => {
    const ranking = Object.values(result.ranking || {});
    const highest = ranking.reduce((maximum, candidate) => Math.max(maximum, candidate.count), 0);
    const leaders = highest > 0 ? ranking.filter((candidate) => candidate.count === highest) : [];
    for (const candidate of ranking) {
      if (!members.has(candidate.id)) {
        members.set(candidate.id, { id: candidate.id, name: candidate.name, totalVotes: 0, questions: [], outright: 0, tied: 0 });
      }
      const member = members.get(candidate.id);
      member.totalVotes += candidate.count;
      if (highest === 0 || candidate.count !== highest) continue;
      const tied = leaders.length > 1;
      member.questions.push({ number: index + 1, question: result.question, votes: highest, tied });
      member[tied ? "tied" : "outright"] += 1;
    }
  });
  return [...members.values()].sort((left, right) => right.questions.length - left.questions.length
    || left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.id.localeCompare(right.id));
}

export function completedRoundReport(snapshot) {
  if (snapshot.phase !== "finished" || !Array.isArray(snapshot.history)
      || snapshot.history.length !== snapshot.question_count || snapshot.question_count < 1) {
    throw new Error("The export is available after all questions have finished.");
  }
  if (!snapshot.self_id || snapshot.self_id !== snapshot.owner_id) {
    throw new Error("Only the room owner can export individual votes.");
  }
  if (!Array.isArray(snapshot.audit_history) || snapshot.audit_history.length !== snapshot.history.length) {
    throw new Error("The owner ballot history is not ready yet.");
  }
  const questions = [];
  const votes = [];
  const guests = [];
  snapshot.history.forEach((result, index) => {
    const audit = snapshot.audit_history[index];
    const participantCount = result.participant_count ?? snapshot.players.length;
    if (audit.question !== result.question || !Array.isArray(audit.votes)
      || audit.votes.length !== participantCount
        || audit.votes.filter((ballot) => Boolean(ballot.candidate_id)).length !== result.total_votes) {
      throw new Error("The owner ballot history is still syncing. Try the export again shortly.");
    }
    const ranking = Object.values(result.ranking || {});
    const highest = ranking.reduce((maximum, candidate) => Math.max(maximum, candidate.count), 0);
    const leaders = highest > 0 ? ranking.filter((candidate) => candidate.count === highest) : [];
    questions.push({
      number: index + 1, question: result.question,
      topMembers: leaders.map((candidate) => candidate.name).join(", ") || "No votes",
      maxVotes: highest, tied: leaders.length > 1, totalVotes: result.total_votes,
      missingVotes: participantCount - result.total_votes,
    });
    for (const ballot of audit.votes) {
      votes.push({
        number: index + 1, question: result.question, player: ballot.name, role: ballot.role,
        votedFor: ballot.candidate_name || "No vote", submitted: Boolean(ballot.candidate_id),
        votedForTop: leaders.some((candidate) => candidate.id === ballot.candidate_id),
      });
    }
    for (const guest of Object.values(result.guest_votes || {})) {
      guests.push({
        number: index + 1, question: result.question, guest: guest.name,
        votedFor: guest.candidate_name || "No vote", points: Number(guest.matched === true), score: guest.score,
      });
    }
  });
  return {
    roomCode: snapshot.code, questionCount: snapshot.question_count,
    members: topVoteSummary(snapshot.history, snapshot.answer_options), questions, votes, guests,
  };
}

function xmlText(value) {
  return String(value ?? "").replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    }[character]));
}

function spreadsheetCell(value, style = "Default") {
  const numeric = typeof value === "number" && Number.isFinite(value);
  return `<Cell ss:StyleID="${style}"><Data ss:Type="${numeric ? "Number" : "String"}">${xmlText(value)}</Data></Cell>`;
}

function spreadsheetSheets(name, headers, rows, widths) {
  const sheets = [];
  const pageSize = 65000;
  for (let offset = 0; offset < Math.max(1, rows.length); offset += pageSize) {
    const sheetName = offset ? `${name} ${Math.floor(offset / pageSize) + 1}` : name;
    const body = rows.slice(offset, offset + pageSize).map((row) => `<Row>${row.map((value) => spreadsheetCell(value)).join("")}</Row>`).join("");
    sheets.push(`<Worksheet ss:Name="${xmlText(sheetName)}"><Table>${widths.map((width) => `<Column ss:Width="${width}"/>`).join("")}
      <Row ss:Height="42">${headers.map((header) => spreadsheetCell(header, "Header")).join("")}</Row>${body}</Table>
      <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`);
  }
  return sheets.join("");
}

export function excelWorkbookXml(snapshot, exportedAt = new Date()) {
  const report = completedRoundReport(snapshot);
  const overview = spreadsheetSheets("Round", ["Room", "Questions", "Players", "Seconds per question", "Exported at (UTC)"],
    [[report.roomCode, report.questionCount, snapshot.players.length, snapshot.round_seconds, exportedAt.toISOString()]], [80, 85, 85, 110, 170]);
  const questions = spreadsheetSheets("Questions", ["Question #", "Question", "Most voted name(s)", "Max votes", "Result", "Votes cast", "Did not vote"],
    report.questions.map((question) => [question.number, question.question, question.topMembers, question.maxVotes,
      question.maxVotes === 0 ? "No votes" : question.tied ? "Tie" : "Unique leader", question.totalVotes, question.missingVotes]), [70, 330, 190, 80, 100, 80, 90]);
  const members = spreadsheetSheets("Scoreboard", ["Answer option", "Questions led (ties included)", "Outright leads", "Tied leads", "Total votes"],
    report.members.map((member) => [member.name, member.questions.length, member.outright, member.tied, member.totalVotes]), [180, 140, 100, 90, 90]);
  const topQuestions = spreadsheetSheets("Top questions", ["Answer option", "Question #", "Question", "Max votes", "Tied lead"],
    report.members.flatMap((member) => member.questions.map((question) => [member.name, question.number, question.question, question.votes, question.tied ? "Yes" : "No"])), [180, 70, 330, 80, 90]);
  const votes = spreadsheetSheets("Vote details", ["Question #", "Question", "Participant", "Role", "Voted for", "Vote submitted", "Picked a top answer"],
    report.votes.map((vote) => [vote.number, vote.question, vote.player, vote.role, vote.votedFor, vote.submitted ? "Yes" : "No", vote.votedForTop ? "Yes" : "No"]), [70, 330, 170, 80, 170, 100, 115]);
  const guests = spreadsheetSheets("Member scores", ["Question #", "Question", "Member", "Voted for", "Points earned", "Cumulative score"],
    report.guests.map((guest) => [guest.number, guest.question, guest.guest, guest.votedFor, guest.points, guest.score]), [70, 330, 170, 170, 100, 110]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">
    <Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>
    <Style ss:ID="Header"><Alignment ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#315BED" ss:Pattern="Solid"/></Style></Styles>
    ${overview}${questions}${members}${topQuestions}${votes}${guests}</Workbook>`;
}