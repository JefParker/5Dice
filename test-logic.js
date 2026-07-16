function calculate5DiceScore(category, dice) {
  const counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
  let sum = 0;
  dice.forEach(d => { counts[d]++; sum += d; });
  
  const hasN = (n) => Object.values(counts).some(c => c >= n);
  
  switch(category) {
    case 'sm-straight': 
      if (counts[1] && counts[2] && counts[3] && counts[4]) return 30;
      if (counts[2] && counts[3] && counts[4] && counts[5]) return 30;
      if (counts[3] && counts[4] && counts[5] && counts[6]) return 30;
      return 0;
  }
}
console.log(calculate5DiceScore('sm-straight', [3,4,5,6,1]));
console.log(calculate5DiceScore('sm-straight', [3,4,5,6,3]));
console.log(calculate5DiceScore('sm-straight', [1,2,3,4,4]));
